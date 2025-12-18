import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);


class APIDataCollector {
    constructor(baseApiUrl = 'https://nitjsr.ac.in/backend/api') {
        this.baseApiUrl = baseApiUrl;
        this.collectedData = {
            people: {
                faculty: [],
                deans: [],
                associateDeans: [],
                hods: [],
                wardens: [],
                staff: []
            },
            notices: [],
            events: [],
            departments: [],
            tenders: {},
            publications: [],
            research: {},
            placement: {},
            calendar: {},
            administration: {},
            miscellaneous: {},
            counters: {},
            pdfs: new Set(),
        };
        this.facultyIds = new Set();
        this.publicationIds = new Set();
    }


    async fetchWithRetry(endpoint, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                const url = `${this.baseApiUrl}${endpoint}`;
                console.log(`Fetching: ${url}`);
                const response = await axios.get(url, { timeout: 30000 });
                return response.data;
            } catch (error) {
                if (i === maxRetries - 1) {
                    console.error(`Failed to fetch ${endpoint}:`, error.message);
                    return null;
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
    }



    extractPdfUrls(data, sourceEndpoint) {
        const pdfs = [];
        const extract = (obj, path = '') => {
            if (!obj) return;

            if (typeof obj === 'string' && obj.toLowerCase().endsWith('.pdf')) {
                let fullUrl;
                if (obj.startsWith('http')) {
                    fullUrl = obj;
                } else {
                    const normalizedPath = obj.startsWith('/') ? obj : `/${obj}`;
                    fullUrl = `https://nitjsr.ac.in/backend${normalizedPath}`;
                }
                pdfs.push({
                    url: fullUrl,
                    source: sourceEndpoint,
                    path: path
                });
            } else if (Array.isArray(obj)) {
                obj.forEach((item, idx) => extract(item, `${path}[${idx}]`));
            } else if (typeof obj === 'object') {
                Object.entries(obj).forEach(([key, val]) => {
                    extract(val, path ? `${path}.${key}` : key);
                });
            }
        };

        extract(data);
        pdfs.forEach(pdf => this.collectedData.pdfs.add(JSON.stringify(pdf)));
        return pdfs;
    }



    async collectPeopleData() {
        console.log('\n=== Collecting People Data ===');

        const depts = ['cs', 'ece', 'eee', 'mech', 'civil', 'chem', 'humanities', 'maths', 'meta', 'phys', 'prod', 'mca'];


        // all faculty - this gives us the faculty_ids
        const allFacultyResponse = await this.fetchWithRetry('/people/faculty');
        if (allFacultyResponse && allFacultyResponse.data) {
            // Extract faculty IDs
            allFacultyResponse.data.forEach(faculty => {
                if (faculty.faculty_id) {
                    this.facultyIds.add(faculty.faculty_id);
                }
            });
            console.log(`Found ${this.facultyIds.size} faculty IDs`);
        }


        // detailed profiles for each faculty
        console.log('Fetching detailed profiles for each faculty...');
        for (const facultyId of this.facultyIds) {
            const profile = await this.fetchWithRetry(`/people/faculty?id=${facultyId}`);
            if (profile) {
                this.collectedData.people.faculty.push({
                    faculty_id: facultyId,
                    profile: profile
                });
                this.extractPdfUrls(profile, `/people/faculty?id=${facultyId}`);
            }
            await new Promise(resolve => setTimeout(resolve, 300));
        }


        // by department (for categorization)
        for (const dept of depts) {
            const deptFaculty = await this.fetchWithRetry(`/people/faculty?dept=${dept}`);
            if (deptFaculty) {
                this.extractPdfUrls(deptFaculty, `/people/faculty?dept=${dept}`);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }


        // deans and their profiles
        const deansResponse = await this.fetchWithRetry('/people/deans?type=dean');
        if (deansResponse && deansResponse.data) {
            for (const dean of deansResponse.data) {
                if (dean.id) {
                    const deanProfile = await this.fetchWithRetry(`/people/faculty?id=${dean.id}`);
                    this.collectedData.people.deans.push({
                        ...dean,
                        detailedProfile: deanProfile
                    });
                    if (deanProfile) {
                        this.extractPdfUrls(deanProfile, `/people/faculty?id=${dean.id}`);
                    }
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }
        }


        // associate deans and their profiles
        const associateDeansResponse = await this.fetchWithRetry('/people/deans?type=associatedean');
        if (associateDeansResponse && associateDeansResponse.data) {
            for (const dean of associateDeansResponse.data) {
                if (dean.id) {
                    const deanProfile = await this.fetchWithRetry(`/people/faculty?id=${dean.id}`);
                    this.collectedData.people.associateDeans.push({
                        ...dean,
                        detailedProfile: deanProfile
                    });
                    if (deanProfile) {
                        this.extractPdfUrls(deanProfile, `/people/faculty?id=${dean.id}`);
                    }
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }
        }


        // Collect responsibilities for all faculty
        console.log('Fetching responsibilities for each faculty...');
        for (const facultyId of this.facultyIds) {
            const responsibility = await this.fetchWithRetry(`/people/responsibility?id=${facultyId}`);
            if (responsibility) {
                const facultyEntry = this.collectedData.people.faculty.find(f => f.faculty_id === facultyId);
                if (facultyEntry) {
                    facultyEntry.responsibilities = responsibility;
                }
                this.extractPdfUrls(responsibility, `/people/responsibility?id=${facultyId}`);
            }
            await new Promise(resolve => setTimeout(resolve, 300));
        }


        // HODs
        const allHods = await this.fetchWithRetry('/hod/all');
        if (allHods) {
            this.collectedData.people.hods = allHods;
            this.extractPdfUrls(allHods, '/hod/all');
        }


        const hodsGeneral = await this.fetchWithRetry('/hod');
        if (hodsGeneral) {
            this.extractPdfUrls(hodsGeneral, '/hod');
        }


        // wardens
        const wardens = await this.fetchWithRetry('/warden');
        if (wardens) {
            this.collectedData.people.wardens = wardens;
            this.extractPdfUrls(wardens, '/warden');
        }


        // warden types
        for (const type of [1, 2, 3]) {
            const wardenType = await this.fetchWithRetry(`/warden?type=${type}`);
            if (wardenType) {
                this.extractPdfUrls(wardenType, `/warden?type=${type}`);
            }
            await new Promise(resolve => setTimeout(resolve, 300));
        }


        // staff
        const staff = await this.fetchWithRetry('/staff');
        if (staff) {
            this.collectedData.people.staff = staff;
            this.extractPdfUrls(staff, '/staff');
        }


        // members for each faculty
        console.log('Fetching members data for each faculty...');
        for (const facultyId of this.facultyIds) {
            const members = await this.fetchWithRetry(`/members?id=${facultyId}`);
            if (members) {
                const facultyEntry = this.collectedData.people.faculty.find(f => f.faculty_id === facultyId);
                if (facultyEntry) {
                    facultyEntry.members = members;
                }
                this.extractPdfUrls(members, `/members?id=${facultyId}`);
            }
            await new Promise(resolve => setTimeout(resolve, 300));
        }


        // faculty courses
        console.log('Fetching courses for each faculty...');
        for (const facultyId of this.facultyIds) {
            const courses = await this.fetchWithRetry(`/faculty_course?id=${facultyId}`);
            if (courses) {
                const facultyEntry = this.collectedData.people.faculty.find(f => f.faculty_id === facultyId);
                if (facultyEntry) {
                    facultyEntry.courses = courses;
                }
                this.extractPdfUrls(courses, `/faculty_course?id=${facultyId}`);
            }
            await new Promise(resolve => setTimeout(resolve, 300));
        }


        // thesis supervised
        console.log('Fetching thesis supervised for each faculty...');
        for (const facultyId of this.facultyIds) {
            const phd = await this.fetchWithRetry(`/thesissupervised/phd?id=${facultyId}`);
            const mtech = await this.fetchWithRetry(`/thesissupervised/mtech?id=${facultyId}`);
            const btech = await this.fetchWithRetry(`/thesissupervised/btech?id=${facultyId}`);

            const facultyEntry = this.collectedData.people.faculty.find(f => f.faculty_id === facultyId);
            if (facultyEntry) {
                facultyEntry.thesisSupervised = {
                    phd: phd,
                    mtech: mtech,
                    btech: btech
                };
            }

            [phd, mtech, btech].forEach(data => {
                if (data) this.extractPdfUrls(data, `/thesissupervised/*?id=${facultyId}`);
            });

            await new Promise(resolve => setTimeout(resolve, 300));
        }

        console.log(`Collected detailed data for ${this.collectedData.people.faculty.length} faculty members`);
    }




    async collectNotices() {
        console.log('\n=== Collecting Notices ===');

        const noticeTypes = [
            { key: 'all', query: '' },
            { key: 'student', query: '?stud=1' },
            { key: 'office', query: '?office=1' },
            { key: 'tender', query: '?tend=1' },
            { key: 'recruitment', query: '?rec=1' },
            { key: 'announcement', query: '?announce=1' },
            { key: 'landing', query: '/landing' },
        ];

        for (const type of noticeTypes) {
            const endpoint = type.query.startsWith('/')
                ? `/notices${type.query}`
                : `/notices${type.query}`;
            const data = await this.fetchWithRetry(endpoint);
            if (data) {
                this.collectedData.notices.push({
                    type: type.key,
                    data: data,
                    endpoint: endpoint
                });
                this.extractPdfUrls(data, endpoint);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        const deptNotices = await this.fetchWithRetry('/department_notices');
        if (deptNotices) {
            this.collectedData.notices.push({
                type: 'department',
                data: deptNotices,
                endpoint: '/department_notices'
            });
            this.extractPdfUrls(deptNotices, '/department_notices');
        }

        const deanNotices = await this.fetchWithRetry('/dean_office_notices');
        if (deanNotices) {
            this.collectedData.notices.push({
                type: 'dean_office',
                data: deanNotices,
                endpoint: '/dean_office_notices'
            });
            this.extractPdfUrls(deanNotices, '/dean_office_notices');
        }

        console.log(`Collected ${this.collectedData.notices.length} notice categories`);
    }



    async collectEvents() {
        console.log('\n=== Collecting Events ===');

        const depts = ['all', 'cs', 'ece', 'eee', 'mech', 'civil', 'chem', 'humanities', 'maths', 'meta', 'phys', 'prod', 'mca'];

        for (const dept of depts) {
            const events = await this.fetchWithRetry(`/events?dept=${dept}`);
            const upcoming = await this.fetchWithRetry(`/events/upcoming?dept=${dept}`);

            this.collectedData.events.push({
                department: dept,
                current: events,
                upcoming: upcoming
            });

            [events, upcoming].forEach(data => {
                if (data) this.extractPdfUrls(data, `/events?dept=${dept}`);
            });

            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log(`Collected events for ${depts.length} departments`);
    }



    async collectDepartments() {
        console.log('\n=== Collecting Department Data ===');

        const depts = ['cs', 'ece', 'eee', 'mech', 'civil', 'chem', 'humanities', 'maths', 'meta', 'phys', 'prod', 'mca'];

        for (const dept of depts) {
            const data = await this.fetchWithRetry(`/department?dept=${dept}`);
            if (data) {
                this.collectedData.departments.push({
                    code: dept,
                    data: data
                });
                this.extractPdfUrls(data, `/department?dept=${dept}`);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log(`Collected data for ${this.collectedData.departments.length} departments`);
    }



    async collectTenders() {
        console.log('\n=== Collecting Tenders ===');

        const types = ['all', 'active', 'archive'];
        const tenders = {};

        for (const type of types) {
            const data = await this.fetchWithRetry(`/tender/${type}`);
            if (data) {
                tenders[type] = data;
                this.extractPdfUrls(data, `/tender/${type}`);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        this.collectedData.tenders = tenders;
        console.log(`Collected ${types.length} tender categories`);
    }



    async collectPublications() {
        console.log('\n=== Collecting Publications ===');

        const allPublicationsResponse = await this.fetchWithRetry('/publications/getAll');
        if (allPublicationsResponse && allPublicationsResponse.result) {
            // Extract publication IDs
            allPublicationsResponse.result.forEach(pub => {
                if (pub.id) {
                    this.publicationIds.add(pub.id);
                }
            });
            console.log(`Found ${this.publicationIds.size} publication IDs`);
        }

        // Fetch detailed view for each publication
        console.log('Fetching detailed views for each publication...');
        for (const pubId of this.publicationIds) {
            const pubDetail = await this.fetchWithRetry(`/publications/view?id=${pubId}`);
            if (pubDetail) {
                this.collectedData.publications.push({
                    id: pubId,
                    details: pubDetail
                });
                this.extractPdfUrls(pubDetail, `/publications/view?id=${pubId}`);
            }
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        const recentPublications = await this.fetchWithRetry('/publications/recent');
        if (recentPublications) {
            this.extractPdfUrls(recentPublications, '/publications/recent');
        }

        console.log(`Collected ${this.collectedData.publications.length} publications with details`);
    }



    async collectResearchData() {
        console.log('\n=== Collecting Research Data ===');

        const allResearch = await this.fetchWithRetry('/research/all');
        const recentResearch = await this.fetchWithRetry('/research/recent');
        const awards = await this.fetchWithRetry('/research/awards?page=1&limit=100');
        this.collectedData.research = {
            all: allResearch,
            recent: recentResearch,
            awards: awards
        };

        const projects = await this.fetchWithRetry('/projects');
        const projectsNID = await this.fetchWithRetry('/projects/NID');
        const projectsExt = await this.fetchWithRetry('/projects/Ext');
        const projectsTC = await this.fetchWithRetry('/projects/T&C');
        this.collectedData.research.projects = {
            all: projects,
            NID: projectsNID,
            External: projectsExt,
            'T&C': projectsTC
        };

        const conferences = await this.fetchWithRetry('/conferences/all');
        this.collectedData.research.conferences = conferences;

        [allResearch, recentResearch, awards, projects, projectsNID, projectsExt, projectsTC, conferences].forEach(data => {
            if (data) this.extractPdfUrls(data, '/research/*');
        });

        console.log('Collected research, publications, projects, and conferences data');
    }



    async collectPlacementData() {
        console.log('\n=== Collecting Placement Data ===');

        const members = await this.fetchWithRetry('/placement/member');
        const stats = await this.fetchWithRetry('/placement/stats');

        this.collectedData.placement = {
            members: members,
            stats: stats
        };

        [members, stats].forEach(data => {
            if (data) this.extractPdfUrls(data, '/placement/*');
        });

        console.log('Collected placement data');
    }



    async collectCalendar() {
        console.log('\n=== Collecting Calendar ===');

        const calendar = await this.fetchWithRetry('/calendar');
        const archiveCalendar = await this.fetchWithRetry('/calendar/archive');

        this.collectedData.calendar = {
            current: calendar,
            archive: archiveCalendar
        };

        [calendar, archiveCalendar].forEach(data => {
            if (data) this.extractPdfUrls(data, '/calendar');
        });

        console.log('Collected calendar data');
    }



    async collectAdministration() {
        console.log('\n=== Collecting Administration Data ===');

        const types = ['senate', 'finance', 'bog', 'bwc'];

        for (const type of types) {
            const data = await this.fetchWithRetry(`/administration?type=${type}`);
            if (data) {
                this.collectedData.administration[type] = data;
                this.extractPdfUrls(data, `/administration?type=${type}`);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log(`Collected ${types.length} administration categories`);
    }



    async collectMiscellaneous() {
        console.log('\n=== Collecting Miscellaneous Data ===');

        const endpoints = [
            { key: 'minutes_senate', endpoint: '/minutes?type=senate' },
            { key: 'minutes_finance', endpoint: '/minutes?type=finance' },
            { key: 'minutes_bog', endpoint: '/minutes?type=bog' },
            { key: 'minutes_bwc', endpoint: '/minutes?type=bwc' },
            { key: 'mou', endpoint: '/mou?sort=asc' },
            { key: 'manuals_forms_all', endpoint: '/manuals_forms/all' },
            { key: 'manuals_forms_student', endpoint: '/manuals_forms/student' },
            { key: 'manuals_forms_employee', endpoint: '/manuals_forms/employee' },
            { key: 'alumni_publication', endpoint: '/alumni_publication' },
            { key: 'alumni_news', endpoint: '/alumni_news' },
            { key: 'media_publication', endpoint: '/media_publication' },
            { key: 'former_directors', endpoint: '/former_directors' },
            { key: 'debarred_agencies', endpoint: '/debarred_agencies' },
            { key: 'iks', endpoint: '/iks' },
        ];

        const miscData = {};
        for (const { key, endpoint } of endpoints) {
            const data = await this.fetchWithRetry(endpoint);
            if (data) {
                miscData[key] = data;
                this.extractPdfUrls(data, endpoint);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        this.collectedData.miscellaneous = miscData;
        console.log(`Collected ${Object.keys(miscData).length} miscellaneous data categories`);
    }



    async collectCounters() {
        console.log('\n=== Collecting Counter Data ===');

        const triggerCount = await this.fetchWithRetry('/counters/trigger-count');
        const syncCount = await this.fetchWithRetry('/counters/sync-count');

        this.collectedData.counters = {
            trigger: triggerCount,
            sync: syncCount
        };

        console.log('Collected counter/visitor data');
    }



    async collectAll() {
        console.log('Starting comprehensive API data collection...\n');

        await this.collectPeopleData();
        await this.collectNotices();
        await this.collectEvents();
        await this.collectDepartments();
        await this.collectTenders();
        await this.collectPublications();
        await this.collectResearchData();
        await this.collectPlacementData();
        await this.collectCalendar();
        await this.collectAdministration();
        await this.collectMiscellaneous();
        await this.collectCounters();

        this.collectedData.pdfList = Array.from(this.collectedData.pdfs).map(json => JSON.parse(json));
        delete this.collectedData.pdfs;

        console.log('\n=== Collection Summary ===');
        console.log(`Total Faculty Profiles: ${this.collectedData.people.faculty.length}`);
        console.log(`Total Publications: ${this.collectedData.publications.length}`);
        console.log(`Total PDF URLs found: ${this.collectedData.pdfList.length}`);
        console.log(`Notices: ${this.collectedData.notices.length} categories`);
        console.log(`Events: ${this.collectedData.events.length} entries`);
        console.log(`Departments: ${this.collectedData.departments.length}`);

        return this.collectedData;
    }



    async saveData(outputDir = '../scraped_data') {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '_');
        const filename = `nitjsr_api_data_${timestamp}.json`;
        const filepath = path.resolve(__dirname, outputDir, filename);

        await fs.mkdir(path.dirname(filepath), { recursive: true });
        await fs.writeFile(filepath, JSON.stringify(this.collectedData, null, 2), 'utf8');

        console.log(`\n💾 API data saved to: ${filepath}`);
        return filepath;
    }
}




class JsonSitemapLoader {
    constructor(sitemapPath, baseUrl = 'https://nitjsr.ac.in') {
        this.sitemapPath = sitemapPath;
        this.baseUrl = baseUrl;
        this.urls = [];
    }

    async load() {
        const sitemapData = JSON.parse(
            await fs.readFile(this.sitemapPath, 'utf8')
        );

        const extractUrls = (items, parentPath = '') => {
            items.forEach(item => {
                if (item.link) {
                    const url = item.link.startsWith('http')
                        ? item.link
                        : `${this.baseUrl}${item.link}`;

                    this.urls.push({
                        url: url,
                        section: item.section || parentPath,
                        name: item.name,
                        depth: 0
                    });
                }

                if (item.sublinks && Array.isArray(item.sublinks)) {
                    extractUrls(item.sublinks, item.section || item.name);
                }
            });
        };

        extractUrls(sitemapData);

        console.log(`Loaded ${this.urls.length} URLs from JSON sitemap`);
        return this.urls;
    }
}

export { APIDataCollector, JsonSitemapLoader };