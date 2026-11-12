// Stand-in command: for each variable name given, prints NAME=value or NAME=<unset>.
const lines = process.argv.slice(2).map((name) => `${name}=${process.env[name] ?? "<unset>"}`);
process.stdout.write(`${lines.join("\n")}\n`);
