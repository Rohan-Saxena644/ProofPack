import 'dotenv/config';
import http from 'node:http';
import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { z } from 'zod';

const escape = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function startLaunchDesk(port: number, mode: 'working' | 'broken', filename = `data/launchdesk-${port}.sqlite`) {
  mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000'); db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,userId TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,sessionToken TEXT);
    CREATE INDEX IF NOT EXISTS projects_user ON projects(userId);`);
  const credential = z.object({ email: z.email().max(200), password: z.string().min(10).max(200) });
  const hash = (pw: string) => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`; };
  const verify = (pw: string, stored: string) => { const [salt, key] = stored.split(':'); return timingSafeEqual(Buffer.from(key, 'hex'), scryptSync(pw, salt, 64)); };
  const render = (body: string, signedIn: boolean, error = '') => `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LaunchDesk · Project workspace</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f7f8fa;color:#1b273b;font:16px system-ui}header{padding:22px 7%;border-bottom:1px solid #e2e6ec;background:white;display:flex;justify-content:space-between;align-items:center}a{color:#315ecc;text-decoration:none}main{max-width:760px;margin:70px auto;padding:0 24px}.card{background:white;padding:36px;border:1px solid #e2e6ec;border-radius:18px;box-shadow:0 10px 30px #172b4d06}h1{font-size:32px;letter-spacing:-1px}p{color:#687487;line-height:1.6}label{display:block;font-size:14px;font-weight:600;margin:22px 0 8px}input{width:100%;padding:13px;border:1px solid #ccd4df;border-radius:8px;font:inherit}button{background:#315ecc;color:white;padding:12px 20px;border:0;border-radius:8px;font:600 14px system-ui;cursor:pointer;margin-top:22px}header button{margin:0;background:#eff3f9;color:#33445f}ul{list-style:none;padding:0}li{padding:18px;background:#f4f7fb;border-radius:8px;margin-top:10px}.eyebrow{font-size:12px;color:#8793a4;letter-spacing:2px}small{color:#768296}.error{color:#b43232;background:#fff1f1;padding:12px}</style><header><a href="/"><strong>◈ LaunchDesk</strong></a>${signedIn ? '<form method="post" action="/logout"><button>Log out</button></form>' : '<a href="/login">Log in</a>'}</header><main><div class="eyebrow">YOUR NEXT IDEA STARTS HERE</div>${error ? `<p role="alert" class="error">${escape(error)}</p>` : ''}${body}<p><small>Local demo workspace · Synthetic accounts only</small></p></main></html>`;
  const server = http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${port}`;
    const url = new URL(req.url ?? '/', origin);
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
    const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('ld_session='))?.slice(11) ?? '';
    const session = db.prepare('SELECT userId FROM sessions WHERE token=? AND expires>?').get(token, Date.now()) as { userId: string } | undefined;
    const redirect = (to: string) => { res.writeHead(303, { Location: to }); res.end(); };
    const send = (body: string, code = 200, error = '') => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(render(body, !!session, error)); };
    const authForm = (register: boolean) => `<h1>${register ? 'Make room for your next idea.' : 'Welcome back.'}</h1><p>${register ? 'Create your account and bring a project to life.' : 'Log in to your project workspace.'}</p><div class="card"><h2>${register ? 'Create an account' : 'Log in'}</h2><form method="post" action="/${register ? 'register' : 'login'}"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" minlength="10" required><button>${register ? 'Create account' : 'Log in'}</button></form><p>${register ? '<a href="/login">Already have an account? Log in</a>' : '<a href="/register">Create an account</a>'}</p></div>`;
    try {
      if (req.method === 'POST') {
        if (req.headers.origin !== origin) return send('', 403, 'Origin rejected');
        let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 8192) return send('', 413, 'Request too large'); }
        const fields = Object.fromEntries(new URLSearchParams(raw));
        if (url.pathname === '/logout') { db.prepare('DELETE FROM sessions WHERE token=?').run(token); res.setHeader('Set-Cookie', 'ld_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return redirect('/login'); }
        if (url.pathname === '/register' || url.pathname === '/login') {
          const parsed = credential.safeParse(fields); const register = url.pathname === '/register';
          if (!parsed.success) return send(authForm(register), 400, 'Use a valid email and a password of at least 10 characters.');
          const { email, password } = parsed.data;
          let user = db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase()) as { id: string; password: string } | undefined;
          if (register) {
            if (user) return send(authForm(true), 409, 'This account already exists.');
            user = { id: randomUUID(), password: hash(password) };
            db.prepare('INSERT INTO users VALUES (?,?,?)').run(user.id, email.toLowerCase(), user.password);
          } else if (!user || !verify(password, user.password)) return send(authForm(false), 401, 'Email or password is incorrect.');
          const newToken = randomBytes(32).toString('hex');
          db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(newToken, user!.id, Date.now() + 86400000);
          res.setHeader('Set-Cookie', `ld_session=${newToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`); return redirect('/projects');
        }
        if (url.pathname === '/projects' && session) {
          const name = z.string().trim().min(1).max(150).parse(fields.name);
          // Deliberate defect: broken instances scope new projects to the current server session.
          db.prepare('INSERT INTO projects VALUES (?,?,?,?)').run(randomUUID(), session.userId, name, mode === 'broken' ? token : null); return redirect('/projects');
        }
        return send('', 404, 'Page not found');
      }
      if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
      if (url.pathname === '/register') return send(authForm(true));
      if (url.pathname === '/login') return send(authForm(false));
      if (!session) return redirect('/register');
      if (url.pathname === '/' || url.pathname === '/projects') {
        const projects = db.prepare('SELECT name FROM projects WHERE userId=? AND (sessionToken IS NULL OR sessionToken=?) ORDER BY rowid DESC').all(session.userId, token) as { name: string }[];
        return send(`<h1>A little space for big ideas.</h1><p>Your workspace, one project at a time.</p><div class="card"><h2>Your projects</h2>${projects.length ? `<ul>${projects.map(p => `<li>${escape(p.name)}</li>`).join('')}</ul>` : '<p>No projects yet. Start something good.</p>'}<form method="post" action="/projects"><label for="name">Project name</label><input id="name" name="name" placeholder="Your next big idea" required maxlength="150"><button>Create project</button></form></div>`);
      }
      return send('', 404, 'Page not found');
    } catch { return send('', 400, 'Unable to process that request.'); }
  });
  server.listen(port, '127.0.0.1', () => console.log(`LaunchDesk ${mode}: http://127.0.0.1:${port}`));
  return { server, close: () => new Promise<void>(resolve => server.close(() => { db.close(); resolve(); })) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const option = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
  const mode = option('mode') === 'broken' ? 'broken' : 'working';
  const app = startLaunchDesk(Number(option('port') ?? 4100), mode);
  process.on('SIGINT', () => { void app.close(); }); process.on('SIGTERM', () => { void app.close(); });
}
