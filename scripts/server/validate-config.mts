/** Validate exactly the settings sent to each Worker before any remote mutation. */
import { loadConfig } from '../../packages/server/src/config.js';

let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const { api, tracker } = JSON.parse(input);
  loadConfig(api, 'api');
  loadConfig(tracker, 'tracker');
  console.log('Production configuration is valid for both Workers.');
} catch (error) {
  // ConfigError contains setting names only. Never print the input or a credential.
  console.error(error instanceof Error ? error.message : 'Invalid production configuration.');
  process.exitCode = 1;
}
