import { readFileSync } from "node:fs";
import path from "node:path";

import type { CommandSpec } from "../contracts/job.js";
import {
  commandProfileFileSchema,
  type SourceContract,
} from "../contracts/source.js";

export class CommandProfiles {
  private readonly profiles;

  constructor(
    input: unknown = { schema: "conductor.command-profiles/v1", profiles: {} },
  ) {
    this.profiles = commandProfileFileSchema.parse(input).profiles;
  }

  static fromEnvironment(): CommandProfiles {
    const target = process.env.CONDUCTOR_COMMAND_PROFILES_FILE;
    if (!target) return new CommandProfiles();
    return new CommandProfiles(JSON.parse(readFileSync(target, "utf8")));
  }

  resolve(
    commands: SourceContract["setup"] | SourceContract["acceptance"],
  ): CommandSpec[] {
    return commands.map((command) => {
      const profile = this.profiles[command.profile];
      if (!profile)
        throw new Error(`Unknown command profile: ${command.profile}`);
      return {
        executable: profile.executable,
        args: [...profile.argsPrefix, ...command.args],
        cwd: command.cwd,
        inheritEnv: profile.inheritEnv,
        timeoutMs: command.timeoutMs,
      };
    });
  }

  executablePaths(): string[] {
    return [
      ...new Set(
        Object.values(this.profiles)
          .map((profile) => profile.executable)
          .filter(path.isAbsolute),
      ),
    ];
  }

  environmentNames(): string[] {
    return [
      ...new Set(
        Object.values(this.profiles).flatMap((profile) => profile.inheritEnv),
      ),
    ];
  }
}
