import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import * as net from 'net';
import * as dotenv from 'dotenv';

const backendDir = resolve(__dirname, '..');
const rootDir = resolve(backendDir, '..');
dotenv.config({ path: resolve(backendDir, '.env') });
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('❌ DATABASE_URL is missing in backend/.env'); process.exit(1); }
function parseDatabaseUrl(url: string): { host: string; port: number } { const match = url.match(/@([^:/]+):(\d+)\//); return match ? { host: match[1], port: parseInt(match[2], 10) } : { host: 'localhost', port: 5432 }; }
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }
async function isPortOpen(host: string, port: number) { return new Promise<boolean>(resolve => { const socket = net.createConnection({ host, port, timeout: 2000 }); socket.on('connect', () => { socket.destroy(); resolve(true); }); socket.on('error', () => resolve(false)); socket.on('timeout', () => { socket.destroy(); resolve(false); }); }); }
function tryStartDocker() { const composeFile = resolve(rootDir, 'docker-compose.yml'); if (!existsSync(composeFile)) return; try { console.log('🐳 PostgreSQL not reachable — trying docker compose up -d ...'); execSync('docker compose up -d', { cwd: rootDir, stdio: 'inherit' }); } catch { console.warn('⚠️ Could not start Docker. Make sure PostgreSQL is running manually.'); } }
async function waitForDatabase(host: string, port: number, maxAttempts = 30) { for (let i=1;i<=maxAttempts;i++) { if (await isPortOpen(host,port)) { console.log(`✅ PostgreSQL is reachable at ${host}:${port}`); return; } if(i===1) tryStartDocker(); console.log(`⏳ Waiting for PostgreSQL... (${i}/${maxAttempts})`); await sleep(2000); } throw new Error(`PostgreSQL not available at ${host}:${port}.`); }
function runPrisma(command: string, input?: string) { execSync(`npx prisma ${command}`, { cwd: backendDir, stdio: input ? ['pipe','inherit','inherit'] : 'inherit', input, env: { ...process.env } }); }
async function main() {
  console.log('\n📦 Setting up database...\n');
  const {host,port}=parseDatabaseUrl(DATABASE_URL); await waitForDatabase(host,port);
  console.log('🔧 Generating Prisma client...'); runPrisma('generate');
  const schemaMatch = DATABASE_URL.match(/[?&]schema=([^&]+)/); const schema = schemaMatch ? decodeURIComponent(schemaMatch[1]) : 'public';
  console.log(`🧩 Ensuring PostgreSQL schema exists: ${schema}`); runPrisma(
  'db execute --stdin --schema=prisma/schema.prisma',
  `CREATE SCHEMA IF NOT EXISTS "${schema.replace(/"/g, '')}";`
);
  console.log('🗄️ Running Prisma migrations...'); runPrisma('migrate deploy');
  console.log('🔄 Verifying Prisma schema and creating any missing tables...'); runPrisma('db push --accept-data-loss');
  console.log('🌱 Inserting safe sample data (existing records are preserved)...'); runPrisma('db seed');
  console.log('\n✅ Database ready and sample data inserted!\n');
}
main().catch(err => { console.error('\n❌ Database setup failed:', err.message || err); process.exit(1); });
