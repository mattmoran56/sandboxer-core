#!/usr/bin/env node
// The entry point. Kept to two lines so the interesting part is testable
// TypeScript rather than something only reachable by spawning a process.
import { main } from "../dist/main.js";

process.exitCode = await main(process.argv.slice(2));
