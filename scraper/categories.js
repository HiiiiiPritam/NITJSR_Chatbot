export class PageCategorizer {

    constructor(baseUrl = 'https://gscc.jharkhand.gov.in') {
        this.baseUrl = baseUrl;
        this.CATEGORY_SEGMENT_MAP = {
            home: 'home',
            aboutus: 'schemes',
            faqviewall: 'faqs',
            contactus: 'contact',
            student: 'portal',
            registration: 'portal',
            institute: 'banks_institutions',
            statuscode: 'general',
            other: 'schemes',
            eklavya: 'schemes',
            mukhyamantri: 'schemes',
        };
    }


    categorizeUrl(url, content = '') {
        // 1) Try URL-based
        const segments = this.getSegments(url);
        for (const seg of segments) {
            if (this.CATEGORY_SEGMENT_MAP[seg]) return this.CATEGORY_SEGMENT_MAP[seg];
        }

        // 2) Try removing plural (schemes -> scheme)
        for (const seg of segments) {
            const singular = seg.endsWith('s') ? seg.slice(0, -1) : null;
            if (singular && this.CATEGORY_SEGMENT_MAP[singular])
                return this.CATEGORY_SEGMENT_MAP[singular];
        }

        // 3) Fallback on content analysis
        const fromContent = this.guessFromContent(content);
        if (fromContent) return fromContent;

        // 4) Default
        return 'general';
    }


    getSegments(url) {
        try {
            const u = new URL(url, this.baseUrl);
            return u.pathname.split('/').filter(Boolean).map(s => s.toLowerCase());
        } catch {
            return [];
        }
    }


    guessFromContent(text = '') {
        const checks = [
            {
                key: 'schemes',
                rx: /\b(scheme|yojna|protsahan|eklavya|guruji|credit\s*card|loan|subsidy|interest|education)\b/i,
            },
            {
                key: 'portal',
                rx: /\b(registration|login|student|apply|application|status|password|username)\b/i,
            },
            {
                key: 'faqs',
                rx: /\b(faq|question|answer|help|instruction|guide)\b/i,
            },
            {
                key: 'banks_institutions',
                rx: /\b(bank|institution|university|college|list|branch|ifsc)\b/i,
            },
            {
                key: 'contact',
                rx: /\b(contact|email|phone|helpline|address|office|support)\b/i,
            },
            {
                key: 'notices',
                rx: /\b(notice|notification|announcement|circular|update|latest)\b/i,
            },
        ];
        for (const { key, rx } of checks) if (rx.test(text)) return key;
        return null;
    }


    specialPdfCategory(url) {
        const lower = String(url || '').toLowerCase();
        if (lower.includes('/backend/uploads/tender/')) return 'tender';
        if (lower.includes('/backend/uploads/notices/')) return 'notices';
        if (lower.includes('/backend/uploads/recruitments/')) return 'notices';
        return null;
    }

}