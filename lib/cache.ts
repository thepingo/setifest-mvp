import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CACHE_DIR = path.join(process.cwd(), '.cache');

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

interface CacheItem {
    expiresAt: number;
    value: any;
    key?: string;
}

class GlobalCache {
    private memory = new Map<string, CacheItem>();

    private getHash(key: string): string {
        return crypto.createHash('sha256').update(key).digest('hex');
    }

    async get(key: string) {
        // 1. Memory check
        const memItem = this.memory.get(key);
        if (memItem) {
            if (memItem.expiresAt > Date.now()) {
                return { value: memItem.value, cached: true, source: 'memory' as const };
            }
            this.memory.delete(key);
        }

        // 2. Disk check
        const hash = this.getHash(key);
        const filePath = path.join(CACHE_DIR, `${hash}.json`);

        if (fs.existsSync(filePath)) {
            try {
                const data = await fs.promises.readFile(filePath, 'utf-8');
                const diskItem: CacheItem = JSON.parse(data);

                if (diskItem.expiresAt > Date.now()) {
                    // Promote to memory
                    this.memory.set(key, diskItem);
                    return { value: diskItem.value, cached: true, source: 'disk' as const };
                } else {
                    await fs.promises.unlink(filePath);
                }
            } catch (err) {
                // Silent error or log it
            }
        }

        return null;
    }

    async set(key: string, value: any, ttlMs: number) {
        const expiresAt = Date.now() + ttlMs;
        const item: CacheItem = { expiresAt, value, key };

        // Set memory
        this.memory.set(key, item);

        // Set disk
        const hash = this.getHash(key);
        const filePath = path.join(CACHE_DIR, `${hash}.json`);
        try {
            await fs.promises.writeFile(filePath, JSON.stringify(item), 'utf-8');
        } catch (err) {
            console.error('Cache Write Error', err);
        }
    }

    async del(key: string) {
        this.memory.delete(key);
        const hash = this.getHash(key);
        const filePath = path.join(CACHE_DIR, `${hash}.json`);
        if (fs.existsSync(filePath)) {
            await fs.promises.unlink(filePath);
        }
    }

    async clearPrefix(prefix: string): Promise<number> {
        let count = 0;
        // Clear memory
        for (const key of Array.from(this.memory.keys())) {
            if (key.startsWith(prefix)) {
                this.memory.delete(key);
                count++;
            }
        }

        // Clear disk
        if (fs.existsSync(CACHE_DIR)) {
            const files = await fs.promises.readdir(CACHE_DIR);
            for (const file of files) {
                const filePath = path.join(CACHE_DIR, file);
                try {
                    const data = await fs.promises.readFile(filePath, 'utf-8');
                    const item: CacheItem = JSON.parse(data);
                    if (item.key?.startsWith(prefix)) {
                        await fs.promises.unlink(filePath);
                        count++;
                    }
                } catch (err) {
                    // Not a cache file or invalid
                }
            }
        }
        return count;
    }
}

// Singleton for the whole app
const globalForCache = global as unknown as { cache: GlobalCache };
export const cache = globalForCache.cache || new GlobalCache();
if (process.env.NODE_ENV !== 'production') globalForCache.cache = cache;
