import logger from './logger.js';
import chat from "@/api/controllers/chat.ts";
import environment from "./environment.ts";

// Process event handlers
process.setMaxListeners(Infinity);
process.on("uncaughtException", (err, origin) => {
    logger.error(`An unhandled error occurred: ${origin}`, err);
});
process.on("unhandledRejection", (_, promise) => {
    promise.catch(err => logger.error("An unhandled rejection occurred:", err));
});
process.on("warning", warning => logger.warn("System warning: ", warning));
process.on("exit", () => {
    logger.info("Service exit");
    logger.footer();
});
process.on("SIGTERM", () => {
    logger.warn("received kill signal");
    process.exit(2);
});
process.on("SIGINT", () => {
    process.exit(0);
});

// Service initialization
export async function initializeService() {
    try {
        // 1. Cloudflare auth first (most important)
        await chat.initCloudflareAuth();
        
        // 2. Get IP (needed for requests)
        await chat.getIPAddress();
        
        // 3. Update app version (less critical)
        await chat.autoUpdateAppVersion();
        
        logger.info('Service initialization completed');
    } catch (error) {
        logger.error('Service initialization failed:', error);
        process.exit(1);
    }
}