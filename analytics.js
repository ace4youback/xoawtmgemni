// ============================================================
// analytics.js — Gemayni Visitor Tracker
// Lưu dữ liệu vào Supabase (free tier, không cần server)
//
// SETUP (1 lần):
// 1. Tạo tài khoản tại https://supabase.com (free)
// 2. Tạo project mới
// 3. Vào SQL Editor, chạy đoạn SQL ở cuối file này
// 4. Vào Settings → API, copy URL và anon key
// 5. Điền vào SUPABASE_URL và SUPABASE_ANON_KEY bên dưới
// ============================================================

const SUPABASE_URL      = 'https://bmpqgdmugalkemwoerpl.supabase.co';   // ← thay vào đây
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtcHFnZG11Z2Fsa2Vtd29lcnBsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NDQ5NTEsImV4cCI6MjA5NTQyMDk1MX0.z_MHCB0hpawd6-vVLSLYf4TY1354BmNSfMeRvksRysA';                      // ← thay vào đây
const ADMIN_PASSWORD    = '6VaH%sdH2gX5/2@';                        // ← đổi mật khẩu admin

// ── Gọi Supabase REST API ────────────────────────────────────
async function sbInsert(table, data) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
        method:  'POST',
        headers: {
            'Content-Type':  'application/json',
            'apikey':         SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Prefer':        'return=minimal',
        },
        body: JSON.stringify(data),
    });
    if (!res.ok) console.warn('[analytics] insert failed', res.status);
}

async function sbSelect(table, params = '') {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
        headers: {
            'apikey':         SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        },
    });
    if (!res.ok) return [];
    return res.json();
}

// ── Lấy thông tin IP / địa lý (có fallback) ─────────────────
async function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), ms || 6000);
    try {
        const r = await fetch(url, { signal: ctrl.signal });
        clearTimeout(id);
        return r;
    } catch(e) { clearTimeout(id); throw e; }
}

async function getGeoInfo() {
    const services = [
        {
            url: 'https://ipwho.is/',
            parse: d => ({ ip: d.ip, country: d.country||'', city: d.city||'', region: d.region||'', org: (d.connection&&(d.connection.org||d.connection.isp))||'', lat: d.latitude, lon: d.longitude }),
            check: d => d.success !== false && !!d.ip,
        },
        {
            url: 'https://ipapi.co/json/',
            parse: d => ({ ip: d.ip, country: d.country_name||'', city: d.city||'', region: d.region||'', org: d.org||'', lat: d.latitude, lon: d.longitude }),
            check: d => !!d.ip && !d.error,
        },
        {
            url: 'https://ip-api.com/json/?fields=status,country,regionName,city,org,query,lat,lon',
            parse: d => ({ ip: d.query, country: d.country||'', city: d.city||'', region: d.regionName||'', org: d.org||'', lat: d.lat, lon: d.lon }),
            check: d => d.status === 'success',
        },
    ];
    for (const svc of services) {
        try {
            const r = await fetchWithTimeout(svc.url, 6000);
            if (!r.ok) continue;
            const d = await r.json();
            if (!svc.check(d)) continue;
            return svc.parse(d);
        } catch(e) { /* thử service tiếp */ }
    }
    return {}; // vẫn insert, chỉ thiếu geo
}

// ── Thu thập thông tin thiết bị ──────────────────────────────
function getDeviceInfo() {
    const ua  = navigator.userAgent;
    const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile/i.test(ua);
    let browser = 'Other';
    if (/Edg\//i.test(ua))          browser = 'Edge';
    else if (/OPR\//i.test(ua))     browser = 'Opera';
    else if (/Chrome\//i.test(ua))  browser = 'Chrome';
    else if (/Firefox\//i.test(ua)) browser = 'Firefox';
    else if (/Safari\//i.test(ua))  browser = 'Safari';

    let os = 'Other';
    if (/Windows/i.test(ua))      os = 'Windows';
    else if (/Mac OS X/i.test(ua)) os = 'macOS';
    else if (/Android/i.test(ua)) os = 'Android';
    else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
    else if (/Linux/i.test(ua))   os = 'Linux';

    return {
        device:     isMobile ? 'Mobile' : 'Desktop',
        browser,
        os,
        screen:     `${screen.width}×${screen.height}`,
        lang:       navigator.language || '',
        tz:         Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        referrer:   document.referrer || 'direct',
        page:       location.pathname,
    };
}

// ── Track visit ──────────────────────────────────────────────
async function trackVisit() {
    // Dùng localStorage (bền hơn sessionStorage trên mobile)
    // Chỉ đếm 1 lần mỗi 30 phút, kể cả khi reload
    const KEY = 'gmy_last_visit';
    const now = Date.now();
    try {
        const last = localStorage.getItem(KEY);
        if (last && now - Number(last) < 30 * 60 * 1000) return;
        localStorage.setItem(KEY, now);
    } catch(e) {
        // localStorage bị block (private mode iOS) → dùng sessionStorage
        const last = sessionStorage.getItem(KEY);
        if (last && now - Number(last) < 30 * 60 * 1000) return;
        sessionStorage.setItem(KEY, now);
    }

    const [geo, dev] = await Promise.all([getGeoInfo(), Promise.resolve(getDeviceInfo())]);
    const record = {
        visited_at: new Date().toISOString(),
        ...geo,
        ...dev,
    };

    await sbInsert('visitors', record);
}

// ── Track action (xóa ảnh / video) ──────────────────────────
window.trackAction = async function(type, detail = {}) {
    await sbInsert('actions', {
        created_at: new Date().toISOString(),
        type,           // 'remove_image' | 'remove_video'
        ...detail,
    });
};

// ── Khởi động ────────────────────────────────────────────────
trackVisit();

// ── Export config để admin.html dùng ─────────────────────────
window._gmyConfig = { SUPABASE_URL, SUPABASE_ANON_KEY, ADMIN_PASSWORD, sbSelect };

/*
──────────────────────────────────────────────────────────────
SQL SETUP — chạy 1 lần trong Supabase SQL Editor:

create table visitors (
  id          bigserial primary key,
  visited_at  timestamptz default now(),
  ip          text,
  country     text,
  city        text,
  region      text,
  org         text,
  lat         float,
  lon         float,
  device      text,
  browser     text,
  os          text,
  screen      text,
  lang        text,
  tz          text,
  referrer    text,
  page        text
);

create table actions (
  id          bigserial primary key,
  created_at  timestamptz default now(),
  type        text,
  file_type   text,
  file_size   bigint
);

-- Cho phép anonymous insert (không cần login)
alter table visitors enable row level security;
alter table actions  enable row level security;

create policy "anon insert visitors" on visitors for insert to anon with check (true);
create policy "anon insert actions"  on actions  for insert to anon with check (true);
create policy "anon select visitors" on visitors for select to anon using (true);
create policy "anon select actions"  on actions  for select to anon using (true);
──────────────────────────────────────────────────────────────
*/
