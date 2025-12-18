import {
    countWords,
    extractTextFromXhrResponses,
    flattenTablesToText,
} from './ragUtils.js';


/**
 * Removes null, undefined, and empty values from metadata
 * Pinecone requires all metadata values to be non-null
 */
function cleanMetadata(metadata) {
    const cleaned = {};
    for (const [key, value] of Object.entries(metadata)) {
        // Skip null, undefined, and empty strings
        if (value !== null && value !== undefined && value !== '') {
            // Convert objects to JSON strings for Pinecone (except arrays)
            if (typeof value === 'object' && !Array.isArray(value)) {
                cleaned[key] = JSON.stringify(value);
            } else {
                cleaned[key] = value;
            }
        }
    }
    return cleaned;
}


/**
 * Detects which scraper format the data is in
 */
function detectScraperFormat(scrapedData) {
    if (scrapedData.scrapeType === 'hybrid_api_and_dom_with_navigation' ||
        scrapedData.metadata?.scrapeType === 'hybrid_api_and_dom_with_navigation') {
        return 'hybrid';
    }
    if (scrapedData.staticPages || scrapedData.apiData) {
        return 'hybrid';
    }
    if (scrapedData.pages) {
        return 'legacy';
    }
    return 'unknown';
}



export function buildPageLinkStats(scrapedData = {}) {
    const stats = new Map();
    const linkBuckets = scrapedData?.links || {};

    const getOrCreateEntry = (sourceUrl) => {
        if (!sourceUrl) return null;
        if (!stats.has(sourceUrl)) {
            stats.set(sourceUrl, {
                total: 0,
                pdf: 0,
                internal: 0,
                external: 0,
                image: 0
            });
        }
        return stats.get(sourceUrl);
    };

    const accumulate = (links = [], type) => {
        if (!Array.isArray(links)) return;
        links.forEach(link => {
            const entry = getOrCreateEntry(link?.sourceUrl);
            if (!entry) return;
            entry.total += 1;
            if (typeof entry[type] === 'number') {
                entry[type] += 1;
            } else {
                entry[type] = 1;
            }
        });
    };

    accumulate(linkBuckets.pdf, 'pdf');
    accumulate(linkBuckets.internal, 'internal');
    accumulate(linkBuckets.external, 'external');
    accumulate(linkBuckets.image, 'image');

    return stats;
}

export function prepareIngestionItems(scrapedData = {}) {
    const format = detectScraperFormat(scrapedData);
    console.log(`[prepareIngestionItems] Detected format: ${format}`);

    if (format === 'hybrid') {
        return prepareHybridIngestionItems(scrapedData);
    } else if (format === 'legacy') {
        return prepareLegacyIngestionItems(scrapedData);
    } else {
        console.warn('[prepareIngestionItems] Unknown scraper format, trying legacy...');
        return prepareLegacyIngestionItems(scrapedData);
    }
}


/**
 * Prepares items from NEW hybrid scraper format
 */
function prepareHybridIngestionItems(scrapedData) {
    const items = [];
    console.log('[prepareHybridIngestionItems] Processing hybrid scraper data');

    // 1. Process Static Pages
    const staticPages = scrapedData.staticPages || [];
    console.log(`[prepareHybridIngestionItems] Processing ${staticPages.length} static pages`);

    for (const page of staticPages) {
        if (!page.content || page.content.trim().length < 100) {
            console.warn(`[prepareHybridIngestionItems] Skipping page ${page.url}: insufficient content`);
            continue;
        }

        const structuredParts = [
            `Title: ${page.title || 'Untitled'}`,
            `URL: ${page.url}`,
            `Category: ${page.category || 'general'}`,
            page.headings?.map(h => `Heading ${h.level}: ${h.text}`).join('\n') || '',
            page.content || '',
            flattenTablesToText(page.tables) || '',
            page.lists?.map(list => list.map(item => `- ${item}`).join('\n')).join('\n\n') || '',
            `Description: ${page.metadata?.description || ''}`,
            `Keywords: ${page.metadata?.keywords || ''}`
        ];

        // Add XHR data if available
        if (page.xhrResponses && page.xhrResponses.length > 0) {
            const xhrText = extractTextFromXhrResponses(page.xhrResponses);
            if (xhrText) {
                structuredParts.push(`\nAPI Data from XHR:\n${xhrText}`);
            }
        }

        const structuredText = structuredParts.filter(Boolean).join('\n\n').trim();
        const wordCount = page.wordCount || countWords(structuredText);

        const metadataBase = {
            source: page.url,
            sourceType: 'static_page',
            url: page.url,
            title: page.title || 'Untitled',
            timestamp: page.timestamp,
            category: page.category || 'general',
            depth: page.depth || 0,
            wordCount: wordCount,
            hasTables: Array.isArray(page.tables) && page.tables.length > 0,
            hasLists: Array.isArray(page.lists) && page.lists.length > 0,
            pdfCount: page.pdfLinks?.length || 0
        };

        items.push({
            url: page.url,
            type: 'static_page',
            title: page.title || 'Untitled',
            category: page.category || 'general',
            structuredText,
            wordCount,
            buildChunkMetadata: (index, totalChunks) => cleanMetadata({
                source: page.url,
                sourceType: 'static_page',
                url: page.url,
                title: page.title || 'Untitled',
                timestamp: page.timestamp,
                category: page.category || 'general',
                depth: page.depth || 0,
                wordCount: wordCount,
                hasTables: Array.isArray(page.tables) && page.tables.length > 0,
                hasLists: Array.isArray(page.lists) && page.lists.length > 0,
                pdfCount: page.pdfLinks?.length || 0,
                hasXHR: page.xhrResponses && page.xhrResponses.length > 0,
                chunkIndex: index,
                totalChunks,
            }),
        });
    }

    // 2. Process API Data - Faculty
    const faculty = scrapedData.apiData?.people?.faculty || [];
    console.log(`[prepareHybridIngestionItems] Processing ${faculty.length} faculty profiles`);

    for (const facultyMember of faculty) {
        if (!facultyMember.profile || !Array.isArray(facultyMember.profile) || !facultyMember.profile[0]) {
            continue;
        }

        const profile = facultyMember.profile[0];
        const structuredText = formatFacultyProfile(facultyMember, profile);

        if (structuredText.trim().length < 100) continue;

        const fullName = `${profile.prename || ''} ${profile.fname || ''} ${profile.lname || ''}`.trim();
        const facultyUrl = `https://nitjsr.ac.in/faculty/${facultyMember.faculty_id}`;

        items.push({
            url: facultyUrl,
            type: 'faculty_profile',
            title: fullName,
            category: 'faculty',
            structuredText,
            wordCount: countWords(structuredText),
            buildChunkMetadata: (index, totalChunks) => cleanMetadata({
                source: facultyUrl,
                sourceType: 'faculty_profile',
                url: facultyUrl,
                title: fullName,
                category: 'faculty',
                department: profile.department,
                facultyId: facultyMember.faculty_id,
                designation: profile.designation,
                email: profile.email,
                chunkIndex: index,
                totalChunks,
            }),
        });
    }

    // 3. Process API Data - Notices
    const noticeCategories = scrapedData.apiData?.notices || [];
    console.log(`[prepareHybridIngestionItems] Processing ${noticeCategories.length} notice categories`);

    for (const noticeCategory of noticeCategories) {
        const notices = noticeCategory.data?.data || [];
        for (const notice of notices) {
            const structuredText = formatNotice(notice, noticeCategory.type);
            if (structuredText.trim().length < 50) continue;

            const noticeUrl = notice.path || `https://nitjsr.ac.in/notices/${notice.id}`;

            items.push({
                url: noticeUrl,
                type: 'notice',
                title: notice.title || 'Untitled Notice',
                category: `notice_${noticeCategory.type}`,
                structuredText,
                wordCount: countWords(structuredText),
                buildChunkMetadata: (index, totalChunks) => cleanMetadata({
                    source: noticeUrl,
                    sourceType: 'notice',
                    url: noticeUrl,
                    title: notice.title || 'Untitled Notice',
                    category: `notice_${noticeCategory.type}`,
                    noticeType: noticeCategory.type,
                    noticeId: notice.id,
                    date: notice.idate ? new Date(parseInt(notice.idate)).toISOString() : undefined, // Use undefined instead of null
                    pdfPath: notice.path || undefined,
                    chunkIndex: index,
                    totalChunks,
                }),
            });
        }
    }

    // 4. Process API Data - Events
    const eventGroups = scrapedData.apiData?.events || [];
    console.log(`[prepareHybridIngestionItems] Processing events from ${eventGroups.length} departments`);

    for (const eventGroup of eventGroups) {
        // Current events
        const currentEvents = eventGroup.current?.data || [];
        for (const event of currentEvents) {
            const structuredText = formatEvent(event, eventGroup.department);
            if (structuredText.trim().length < 50) continue;

            items.push({
                url: `https://nitjsr.ac.in/events/${event.id}`,
                type: 'event',
                title: event.title || 'Untitled Event',
                category: 'events',
                structuredText,
                wordCount: countWords(structuredText),
                buildChunkMetadata: (index, totalChunks) => cleanMetadata({
                    source: `https://nitjsr.ac.in/events/${event.id}`,
                    sourceType: 'event',
                    url: `https://nitjsr.ac.in/events/${event.id}`,
                    title: event.title || 'Untitled Event',
                    category: 'events',
                    department: eventGroup.department,
                    eventType: 'current',
                    startDate: event.start_date || undefined,
                    endDate: event.end_date || undefined,
                    brochure: event.brochure || undefined,
                    chunkIndex: index,
                    totalChunks,
                }),
            });
        }

        // Upcoming events
        const upcomingEvents = eventGroup.upcoming?.data || [];
        for (const event of upcomingEvents) {
            const structuredText = formatEvent(event, eventGroup.department);
            if (structuredText.trim().length < 50) continue;

            items.push({
                url: `https://nitjsr.ac.in/events/upcoming/${event.id}`,
                type: 'event',
                title: event.title || 'Untitled Event',
                category: 'events_upcoming',
                structuredText,
                wordCount: countWords(structuredText),
                buildChunkMetadata: (index, totalChunks) => cleanMetadata({
                    source: `https://nitjsr.ac.in/events/upcoming/${event.id}`,
                    sourceType: 'event',
                    url: `https://nitjsr.ac.in/events/upcoming/${event.id}`,
                    title: event.title || 'Untitled Event',
                    category: 'events_upcoming',
                    department: eventGroup.department,
                    eventType: 'upcoming',
                    startDate: event.start_date || undefined,
                    endDate: event.end_date || undefined,
                    brochure: event.brochure || undefined,
                    chunkIndex: index,
                    totalChunks,
                }),
            });
        }
    }

    // 5. Process API Data - Departments
    const departments = scrapedData.apiData?.departments || [];
    console.log(`[prepareHybridIngestionItems] Processing ${departments.length} departments`);

    for (const dept of departments) {
        const structuredText = formatDepartment(dept);
        if (structuredText.trim().length < 100) continue;

        items.push({
            url: `https://nitjsr.ac.in/departments/${dept.code}`,
            type: 'department',
            title: `Department of ${dept.code.toUpperCase()}`,
            category: 'departments',
            structuredText,
            wordCount: countWords(structuredText),
            buildChunkMetadata: (index, totalChunks) => cleanMetadata({
                source: `https://nitjsr.ac.in/departments/${dept.code}`,
                sourceType: 'department',
                url: `https://nitjsr.ac.in/departments/${dept.code}`,
                title: `Department of ${dept.code.toUpperCase()}`,
                category: 'departments',
                departmentCode: dept.code,
                chunkIndex: index,
                totalChunks,
            }),
        });
    }

    // 6. Process API Data - Publications
    const publications = scrapedData.apiData?.publications || [];
    console.log(`[prepareHybridIngestionItems] Processing ${publications.length} publications`);

    for (const pub of publications) {
        if (!pub.details?.result) continue;

        const publication = pub.details.result;
        const structuredText = formatPublication(publication);
        if (structuredText.trim().length < 100) continue;

        items.push({
            url: publication.link || `https://nitjsr.ac.in/publications/${pub.id}`,
            type: 'publication',
            title: publication.title || 'Untitled Publication',
            category: 'research_publications',
            structuredText,
            wordCount: countWords(structuredText),
            buildChunkMetadata: (index, totalChunks) => cleanMetadata({
                source: publication.link || `https://nitjsr.ac.in/publications/${pub.id}`,
                sourceType: 'publication',
                url: publication.link || `https://nitjsr.ac.in/publications/${pub.id}`,
                title: publication.title || 'Untitled Publication',
                category: 'research_publications',
                publicationType: publication.type,
                year: publication.pub_date,
                authors: publication.authors,
                journal: publication.journal || undefined,
                chunkIndex: index,
                totalChunks,
            }),
        });
    }


    // 7. Process Additional Data - Curriculum
    if (scrapedData.additionalData?.curriculum) {
        console.log(`[prepareHybridIngestionItems] Processing curriculum data`);

        for (const dept of scrapedData.additionalData.curriculum) {
            // console.log(`Dept: ${dept.department}`);
            const structuredText = formatCurriculum(dept);
            console.log("hogaya bc", structuredText);
            if (structuredText.trim().length < 100) continue;

            items.push({
                url: `virtual://curriculum/${dept.department}`,
                type: 'curriculum',
                title: `Curriculum - ${dept.department}`,
                category: 'curriculum',
                structuredText,
                wordCount: countWords(structuredText),
                buildChunkMetadata: (index, totalChunks) => cleanMetadata({
                    source: `virtual://curriculum/${dept.department}`,
                    sourceType: 'curriculum',
                    title: `Curriculum - ${dept.department}`,
                    category: 'curriculum',
                    department: dept.department,
                    chunkIndex: index,
                    totalChunks: totalChunks,
                }),
            });
        }
    }



    // 8. Process Web Team Data
    if (scrapedData.additionalData?.webTeam) {
        console.log(`[prepareHybridIngestionItems] Processing webteam data`);
        const webTeamText = formatWebTeam(scrapedData.additionalData.webTeam);
        console.log('format to hogyaaa');
        items.push({
            url: 'virtual://webteam',
            type: 'webteam',
            title: 'NIT Jamshedpur Web Team',
            category: 'about',
            structuredText: webTeamText,
            wordCount: countWords(webTeamText),
            buildChunkMetadata: (index, totalChunks) => cleanMetadata({
                source: 'virtual://webteam',
                sourceType: 'webteam',
                title: 'NIT Jamshedpur Web Team',
                category: 'about',
                chunkIndex: index,
                totalChunks: totalChunks,
            }),
        });
        console.log("push bhi hogya");
    }



// 9. Process TAP Contacts
    if (scrapedData.additionalData?.tapContacts) {
        console.log(`[prepareHybridIngestionItems] Processing tapContacts data`);
        const tapText = formatTAPContacts(scrapedData.additionalData.tapContacts);
        console.log('format to hogyaaa');
        items.push({
            url: 'virtual://tap-contacts',
            type: 'contacts',
            title: 'Training and Placement Contacts',
            category: 'placement',
            structuredText: tapText,
            wordCount: countWords(tapText),
            buildChunkMetadata: (index, totalChunks) => cleanMetadata({
                source: 'virtual://tap-contacts',
                sourceType: 'contacts',
                title: 'Training and Placement Contacts',
                category: 'placement',
                chunkIndex: index,
                totalChunks: totalChunks,
            }),
        });
        console.log("push bhi hogya");
    }

// Helper formatting functions
    function formatCurriculum(dept) {
        const parts = [`# Curriculum - ${dept.department}\n`];
        console.log(dept.programs);
        dept.programs.forEach(program => {
            parts.push(`## ${program.title}`);
            parts.push(`Document: ${program.link}\n`);
        });

        return parts.join('\n');
    }

    function formatWebTeam(webTeam) {
        const parts = ['# NIT Jamshedpur Web Team\n'];

        parts.push('## Current Team Members\n');
        webTeam.current.forEach(member => {
            parts.push(`- ${member.name} - ${member.post} (${member.batch})`);
        });

        parts.push('\n## Previous Team Members\n');
        webTeam.previous.forEach(member => {
            parts.push(`- ${member.name} (${member.batch})`);
        });

        return parts.join('\n');
    }



    function formatTAPContacts(tapContacts) {
        const parts = ['# Training and Placement Cell Contacts\n'];

        parts.push('## PI Coordinators\n');
        tapContacts.pi.forEach(contact => {
            parts.push(`${contact.name} - ${contact.role}`);
            parts.push(`Mobile: ${contact.mobile}, Email: ${contact.email}\n`);
        });

        parts.push('## UG Coordinators\n');
        tapContacts['TAP Coordinators - UG'].forEach(contact => {
            parts.push(`${contact.name} (${contact.branch}) - ${contact.mobile}`);
        });

        parts.push('\n## PG Coordinators\n');
        tapContacts['TAP Coordinators - PG'].forEach(contact => {
            parts.push(`${contact.name} (${contact.branch}) - ${contact.mobile}`);
        });

        parts.push('\n## Faculty Coordinators\n');
        tapContacts['Faculty Coordinators'].forEach(contact => {
            parts.push(`${contact.name} - ${contact.branch}`);
            parts.push(`Mobile: ${contact.mobile}, Email: ${contact.email}\n`);
        });

        return parts.join('\n');
    }



    // 7. Create PDF Directory from allPdfUrls
    const allPdfUrls = scrapedData.allPdfUrls || [];
    if (allPdfUrls.length > 0) {
        console.log(`[prepareHybridIngestionItems] Creating PDF directory with ${allPdfUrls.length} PDFs`);

        const pdfContent = [
            `NIT Jamshedpur - PDF Documents Directory`,
            `Total PDFs Available: ${allPdfUrls.length}`,
            `\nPDF Documents:`,
            ...allPdfUrls.slice(0, 200).map(pdf =>
                `- ${pdf.text || pdf.sourceTitle || 'Document'} (${pdf.url})`
            )
        ].join('\n');

        items.push({
            url: 'virtual://pdf-directory',
            type: 'directory',
            title: 'PDF Documents Directory',
            category: 'virtual',
            structuredText: pdfContent,
            wordCount: countWords(pdfContent),
            buildChunkMetadata: (index, totalChunks) => cleanMetadata({
                source: 'virtual://pdf-directory',
                sourceType: 'pdf_directory',
                url: 'virtual://pdf-directory',
                title: 'PDF Documents Directory',
                category: 'virtual',
                totalPdfs: allPdfUrls.length,
                chunkIndex: index,
                totalChunks,
            }),
        });
    }

    console.log(`[prepareHybridIngestionItems] Total items prepared: ${items.length}`);
    console.log(`[prepareHybridIngestionItems] Breakdown:`,
        items.reduce((acc, item) => {
            acc[item.type] = (acc[item.type] || 0) + 1;
            return acc;
        }, {})
    );

    return items;
}

/**
 * Prepares items from OLD legacy scraper format (your original code)
 */
function prepareLegacyIngestionItems(scrapedData) {
    const items = [];
    console.log('[prepareLegacyIngestionItems] Processing legacy scraper data');

    const pageLinkStats = buildPageLinkStats(scrapedData);
    const pages = scrapedData.pages || [];

    for (const page of pages) {
        const xhrText = extractTextFromXhrResponses(page?.xhrResponses || []);
        const structuredParts = [
            `Title: ${page.title || ''}`,
            `URL: ${page.url}`,
            `Category: ${page.category || 'general'}`,
            page.headings?.map(h => `Heading ${h.level}: ${h.text}`).join('\n') || '',
            page.content || '',
            flattenTablesToText(page.tables) || '',
            page.lists?.map(list => list.map(item => `- ${item}`).join('\n')).join('\n\n') || '',
            `Description: ${page.metadata?.description || ''}`,
            `Keywords: ${page.metadata?.keywords || ''}`
        ];

        if (xhrText) {
            structuredParts.push(`XHR API Insights:\n${xhrText}`);
        }

        const structuredText = structuredParts.filter(Boolean).join('\n\n');

        if (!structuredText || structuredText.trim().length <= 100) {
            continue;
        }

        const hasXhr = Boolean(xhrText);
        const combinedWordCount = countWords(structuredText);
        const linkStats = pageLinkStats.get(page.url) || { total: 0, pdf: 0, internal: 0, external: 0, image: 0 };

        const metadataBase = {
            source: 'webpage',
            sourceType: 'page',
            url: page.url,
            title: page.title,
            timestamp: page.timestamp,
            category: page.category || 'general',
            depth: page.depth || 0,
            wordCount: combinedWordCount || page.wordCount || 0,
            hasLinks: (linkStats.total || 0) > 0,
            linkStats,
            hasTables: Array.isArray(page.tables) && page.tables.length > 0,
            hasLists: Array.isArray(page.lists) && page.lists.length > 0,
            hasXHR: hasXhr,
            xhrCount: Array.isArray(page?.xhrResponses) ? page.xhrResponses.length : 0,
        };

        items.push({
            url: page.url,
            type: page.type || 'page',
            title: page.title || '',
            category: page.category || 'general',
            structuredText,
            wordCount: combinedWordCount || page.wordCount || 0,
            buildChunkMetadata: (index, totalChunks) => cleanMetadata({
                ...metadataBase,
                linkStats: JSON.stringify(metadataBase.linkStats || {}),
                chunkIndex: index,
                totalChunks,
            }),
        });
    }

    // Rest of your legacy code...
    const pdfs = scrapedData.documents?.pdfs || [];
    for (const pdf of pdfs) {
        const pdfContent = pdf.text || pdf.content || '';
        if (!pdfContent || pdfContent.trim().length <= 100) continue;

        const structuredPdfText = [
            `PDF Title: ${pdf.title}`,
            `URL: ${pdf.url}`,
            `Category: ${pdf.category || 'general'}`,
            `Pages: ${pdf.pages}`,
            `Source Page: ${pdf.parentPageTitle || 'Unknown'}`,
            `Content: ${pdfContent}`
        ].filter(Boolean).join('\n\n');

        items.push({
            url: pdf.url,
            type: 'pdf',
            title: pdf.title || '',
            category: pdf.category || 'general',
            structuredText: structuredPdfText,
            wordCount: pdf.wordCount || countWords(structuredPdfText),
            buildChunkMetadata: (index, totalChunks) => cleanMetadata({
                source: 'pdf',
                sourceType: 'pdf_document',
                url: pdf.url,
                title: pdf.title,
                pages: pdf.pages,
                category: pdf.category || 'general',
                chunkIndex: index,
                totalChunks,
            }),
        });
    }

    console.log(`[prepareLegacyIngestionItems] Total items prepared: ${items.length}`);
    return items;
}

// Helper formatting functions

function formatFacultyProfile(faculty, profile) {
    const parts = [];
    const fullName = `${profile.prename || ''} ${profile.fname || ''} ${profile.lname || ''}`.trim();

    parts.push(`Faculty Profile: ${fullName}`);
    parts.push(`Faculty ID: ${faculty.faculty_id}`);
    parts.push(`Email: ${profile.email}`);
    parts.push(`Department: ${profile.department}`);
    parts.push(`Designation: ${profile.designation}`);

    if (profile.office_add) {
        parts.push(`\nOffice Address: ${profile.office_add}`);
    }

    if (profile.bio) {
        parts.push(`\nBiography:\n${stripHtml(profile.bio)}`);
    }

    if (faculty.courses?.data?.length > 0) {
        parts.push(`\nCourses Taught:`);
        faculty.courses.data.forEach(course => {
            parts.push(`- ${course.course_code}: ${course.course_name}`);
        });
    }

    if (faculty.thesisSupervised?.phd?.data?.length > 0) {
        parts.push(`\nPhD Students Supervised:`);
        faculty.thesisSupervised.phd.data.slice(0, 10).forEach(thesis => {
            parts.push(`- ${thesis.student_name}: ${thesis.thesis_title}`);
        });
    }

    if (faculty.responsibilities?.data?.length > 0) {
        parts.push(`\nResponsibilities:`);
        faculty.responsibilities.data.forEach(resp => {
            parts.push(`- ${resp.responsibility}`);
        });
    }

    return parts.join('\n');
}

function formatNotice(notice, type) {
    return [
        `Notice: ${notice.title}`,
        `Type: ${type}`,
        notice.idate ? `Date: ${new Date(parseInt(notice.idate)).toLocaleDateString()}` : '',
        notice.path ? `Document: ${notice.path}` : '',
        notice.notification_for?.length > 0 ? `Categories: ${notice.notification_for.join(', ')}` : ''
    ].filter(Boolean).join('\n');
}

function formatEvent(event, department) {
    return [
        `Event: ${event.title}`,
        `Department: ${department}`,
        event.start_date ? `Start: ${new Date(event.start_date).toLocaleDateString()}` : '',
        event.end_date ? `End: ${new Date(event.end_date).toLocaleDateString()}` : '',
        event.desc ? `\n${event.desc}` : '',
        event.brochure ? `Brochure: ${event.brochure}` : ''
    ].filter(Boolean).join('\n');
}

function formatDepartment(dept) {
    const parts = [`Department: ${dept.code.toUpperCase()}`];
    if (dept.data && typeof dept.data === 'object') {
        Object.entries(dept.data).forEach(([key, value]) => {
            if (value && typeof value === 'string' && value.length < 500) {
                parts.push(`${key}: ${value}`);
            }
        });
    }
    return parts.join('\n');
}

function formatPublication(pub) {
    return [
        `Publication: ${pub.title}`,
        `Type: ${pub.type}`,
        `Authors: ${pub.authors}`,
        `Year: ${pub.pub_date}`,
        pub.journal ? `Published in: ${pub.journal}` : '',
        pub.page_no ? `Pages: ${pub.page_no}` : '',
        pub.link ? `Link: ${pub.link}` : ''
    ].filter(Boolean).join('\n');
}


function stripHtml(html) {
    return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}