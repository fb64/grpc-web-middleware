// Runs the test upstream in its own process and prints its port, so a test can SIGKILL it.
import { startUpstream } from './upstream.ts'

const upstream = await startUpstream()
// A string, not a number: console.log colours numbers when FORCE_COLOR is set (node --test in a terminal).
console.log(String(upstream.port))
