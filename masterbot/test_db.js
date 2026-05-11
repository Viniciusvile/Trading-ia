
import pg from 'pg';
import { config as dotenvConfig } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const __envPath = join(__dirname, "..", ".env");
dotenvConfig({ path: __envPath });

const { Pool } = pg;

async function test() {
    console.log("Testing DATABASE_URL:", process.env.DATABASE_URL);
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        const client = await pool.connect();
        console.log("✅ Connected successfully!");
        const res = await client.query('SELECT NOW()');
        console.log("Time from DB:", res.rows[0]);
        client.release();
    } catch (err) {
        console.error("❌ Connection failed:", err.message);
    } finally {
        await pool.end();
    }
}

test();
