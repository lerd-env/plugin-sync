// What every command needs first: its options, from argv in a terminal or JSON
// on stdin from an MCP tool, and the site, named or the project it runs in.
const readline = require('node:readline');
const { parseArgs, mcpInput } = require('./args');

function context(usage, booleans = []) {
  const input = mcpInput();
  const opts = input ? { ...input, _: [] } : parseArgs(process.argv.slice(2), booleans);
  const site = opts.site || (input ? null : opts._.shift()) || process.env.LERD_SITE;
  if (!site) throw new Error(`run it inside a linked project, or name the site: ${usage}`);
  return { opts, site, mcp: !!input };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a.trim()))));
}

// A yes for something that cannot be undone from here: --yes, or the expected
// answer typed at a terminal. Nobody can type over MCP or a pipe, so those need --yes.
async function confirm(opts, question, expected = 'y') {
  if (opts.yes) return;
  if (!process.stdin.isTTY) throw new Error('this needs a confirmation; pass --yes');
  const answer = await ask(`${question} `);
  if (answer.toLowerCase() !== expected.toLowerCase()) throw new Error('not confirmed; nothing was changed');
}

function run(main) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { context, confirm, run };
