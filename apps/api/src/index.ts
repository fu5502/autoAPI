import { buildApp } from "./app.js";

const { app, config } = await buildApp();

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
