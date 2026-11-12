// Stand-in command: prints each argument on its own line on standard output.
process.stdout.write(`${process.argv.slice(2).join("\n")}\n`);
