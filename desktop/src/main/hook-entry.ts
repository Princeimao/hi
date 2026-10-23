import { parseHookArgs, runHookCli } from "./hook-cli";

const args = parseHookArgs(process.argv.slice(1));
if (args) {
  runHookCli(args)
    .then((code) => process.exit(code))
    .catch(() => process.exit(0));
} else {
  process.exit(0);
}
