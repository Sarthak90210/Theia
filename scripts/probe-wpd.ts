// Read-only. Pass the exact AFC UDID and the filenames to inspect.
import { wpdInventory } from '../src/device/wpd.ts'
const [udid, ...names] = process.argv.slice(2)
if (!udid || !names.length) throw new Error('Usage: npx tsx scripts/probe-wpd.ts UDID IMG_0001.HEIC')
console.log(JSON.stringify(await wpdInventory(udid, names), null, 2))
