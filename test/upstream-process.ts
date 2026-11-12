// Runs the test upstream in its own process and prints its port, so a test can SIGKILL it.
import { startUpstream } from './upstream.ts'

const upstream = await startUpstream()
console.log(upstream.port)
