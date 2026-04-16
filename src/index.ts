import { ZodError } from "zod";

import { loadConfig } from "./config";
import { EmailTranslationService } from "./email";

try {
  const config = loadConfig();
  const service = new EmailTranslationService(config);

  await service.runForever();
} catch (error) {
  if (error instanceof ZodError) {
    console.error("invalid environment");
    console.error(error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
  } else {
    console.error(error instanceof Error ? error.message : error);
  }

  process.exit(1);
}
