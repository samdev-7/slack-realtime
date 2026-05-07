import { extractCookie } from "./extract-creds.js";

// Prints the decrypted Slack `d` cookie to stdout, nothing else, no newline
// trailing extras. Pipe it where you need it:
//   npm run --silent print-cookie | pbcopy
//   npm run --silent print-cookie > .env.cookie
process.stdout.write(extractCookie());
