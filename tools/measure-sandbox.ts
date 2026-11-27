// Developer diagnostic, not a second environment lifecycle interface.
import { measureSandbox } from "../packages/core/dist/sandbox/measure.js";

const [container, seconds, readyPort, readyPath] = process.argv.slice(2);
if (!container) {
  console.error("Usage: npm run measure -- <container> [seconds=30] [ready-port] [ready-path=/health]");
  process.exitCode = 1;
} else {
  try {
    const report = await measureSandbox({
      container,
      ...(seconds === undefined ? {} : { seconds: Number(seconds) }),
      ...(readyPort === undefined ? {} : { readyPort: Number(readyPort) }),
      ...(readyPath === undefined ? {} : { readyPath }),
    });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
