import { Redis as RedisClient, RedisOptions } from 'ioredis';

export type RedisManagerConfigBase = Omit<
    RedisOptions,
    "retryStrategy" | "enableOfflineQueue" | "maxRetriesPerRequest"
>;

export type RedisConfig = {
    default: RedisManagerConfigBase;
} & Record<string, RedisManagerConfigBase>

export type RedisMangerConfig<T extends string = string> = {
    default: RedisManagerConfigBase;
} & Record<T, RedisManagerConfigBase>;

type ExtendedRedisClient<K extends string> = RedisClient & {
    connection: (key: K) => RedisClient;
};

class RedisManager {
    private static instances: Map<string, RedisClient> = new Map();
    private static initialized = false;

    private constructor() { }

    static init<K extends string>(config: RedisMangerConfig<K>, force = false) {
        if (this.initialized && !force) {
            return this.createProxy<K>();
        }

        if (force) this.shutdown();

        for (const key of Object.keys(config) as K[]) {
            this.createInstance(key, config[key]);
        }

        this.initialized = true;

        return this.createProxy<K>();
    }

    private static createInstance(key: string, opt: RedisOptions): RedisClient {
        if (this.instances.has(key)) return this.instances.get(key)!;

        const client = new RedisClient({
            ...opt,
            retryStrategy: (times) => Math.min(times * 100, 5000),
            enableOfflineQueue: true,
            maxRetriesPerRequest: 3,
        });

        client.on('connect', () => console.info(`Redis "${key}" connected`));
        client.on('ready', () => console.info(`Redis "${key}" ready`));
        client.on('error', (err) => console.error(`Redis "${key}" error:`, err));
        client.on('close', () => console.info(`Redis "${key}" closed`));
        client.on('reconnecting', () => console.info(`Redis "${key}" reconnecting`));
        client.on('end', () => {
            console.info(`Redis "${key}" ended`);
            this.instances.delete(key);
        });

        this.instances.set(key, client);
        return client;
    }

    private static connection<K extends string>(key: K): RedisClient {
        if (!this.instances.has(key)) {
            throw new Error(`Redis connection "${key}" not found`);
        }
        return this.instances.get(key)!;
    }

    private static createProxy<K extends string>() {

        const proxy = new Proxy({} as RedisClient, {
            get(_, prop: string) {
                const client = RedisManager.connection<K>('default' as K);
                if (prop in client) {
                    const value = (client as any)[prop];
                    return typeof value === 'function' ? value.bind(client) : value;
                }
                throw new Error(`Redis method ${prop} not found`);
            }
        }) as ExtendedRedisClient<K>;

        proxy.connection = this.connection as (key: K) => RedisClient;

        return proxy;
    }

    private static async shutdown(): Promise<void> {
        if (!this.initialized) return;
        console.info("Shutting down Redis connections...");
        const promises: Promise<string>[] = [];
        this.instances.forEach((redis, name) => {
            promises.push(redis.quit()
                .then(() => {
                    console.log(`Redis connection "${name}" closed.`);
                    return name
                }));
        });
        await Promise.all(promises);
        this.instances.clear();
        this.initialized = false;
        console.info("All Redis connections closed.");
    }

    static registerShutdownHooks() {
        if (this.initialized) {
            process.on('SIGINT', async () => {
                await RedisManager.shutdown();
                process.exit(0);
            });

            process.on('SIGTERM', async () => {
                await RedisManager.shutdown();
                process.exit(0);
            });
            console.info("Shutdown hooks registered for Redis connections.");

        }
    }
}

export default RedisManager;
