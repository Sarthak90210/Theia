import path from 'node:path'
import type { DeviceSource } from '../device/types.ts'
import type { OpenVault } from '../vault/vault.ts'
import type { SaveItem } from '../vault/save.ts'
import type { DecodeResult } from '../verify/decode.ts'
import { checkForDeletion, logDeletion, type CheckedFile } from './phone-cleanup.ts'
import type { PhoneObject, WpdInventory } from '../device/wpd.ts'

export interface CleanupResult { deleted: number; kept: number; reasons: { item: string; reason: string }[] }
export interface CleanupDeps {
  inventory(udid: string, names: string[], signal?: AbortSignal): Promise<WpdInventory>
  hash(udid: string, object: PhoneObject, signal?: AbortSignal): Promise<{ object: PhoneObject; bytes: number; sha256: string }>
  remove(udid: string, files: { object: PhoneObject; sha256: string; bytes: number; destination: string }[], signal?: AbortSignal): Promise<{ deleted: Set<string>; failed: Map<string, string> }>
  decode(file: string, mime: string): Promise<DecodeResult>
  paths(item: SaveItem): Promise<string[]>
  progress(stage: 'checking-deletion' | 'deleting', item: string): void
  signal?: AbortSignal
}

/** All selected items are checked before the first driver deletion is requested. */
export async function cleanupSavedPhone(vault: OpenVault, udid: string, device: DeviceSource, items: SaveItem[],
  assets: Record<string, number>, deps: CleanupDeps): Promise<CleanupResult> {
  const result: CleanupResult = { deleted: 0, kept: 0, reasons: [] }
  const keep = (item: SaveItem, reason: string) => { result.kept++; result.reasons.push({ item: item.files[0]?.name ?? item.key, reason }) }
  const plans: {item: SaveItem;files:CheckedFile[];objects:PhoneObject[]}[] = []
  let inventory: WpdInventory | undefined
  let inventoryFailure: Error | undefined
  const log = path.join(path.dirname(vault.layout.db), 'iphone-cleanup.jsonl')
  for (const item of items) {
    try {
      if (deps.signal?.aborted) throw new Error('Stopped before iPhone deletion.')
      if (item.cloud || !assets[item.key]) throw new Error('Every component was not saved successfully in this run.')
      const assetId = assets[item.key]!
      const row = vault.db.prepare('SELECT source_uuid FROM asset WHERE id = ?').get(assetId) as {source_uuid:string|null}|undefined
      if (!item.sourceUuid || row?.source_uuid !== item.sourceUuid) throw new Error('The saved item identity does not match the selected iPhone item.')
      deps.progress('checking-deletion', item.files[0]?.name ?? item.key)
      const snapshots = new Map(item.files.filter(f => f.sourcePath && f.size !== null && f.sourceMtimeMs !== undefined)
        .map(f => [f.sourcePath!, {size:f.size!,mtimeMs:f.sourceMtimeMs!}]))
      const paths = await deps.paths(item)
      const checked = await checkForDeletion(vault, assetId, device, paths, snapshots, deps.signal, deps.decode)
      if (!checked.ok) throw new Error(checked.reason)
      if (inventoryFailure) throw inventoryFailure
      if (!inventory) {
        try { inventory = await deps.inventory(udid, items.flatMap(i => i.files.map(f => f.name)), deps.signal) }
        catch (e) { inventoryFailure = e as Error; throw e }
      }
      if (!inventory.deleteSupported) throw new Error('This iPhone driver does not support file deletion.')
      const objects: PhoneObject[] = []
      for (const file of checked.files) {
        const candidates = inventory.objects.filter(o => o.canDelete && o.name.toLowerCase() === file.name.toLowerCase() && o.bytes === file.size)
        const matches: PhoneObject[] = []
        for (const candidate of candidates) {
          const current = await deps.hash(udid, candidate, deps.signal)
          if (current.bytes === file.size && current.sha256 === file.sha256) matches.push(current.object)
        }
        if (matches.length !== 1) throw new Error(`${file.name}: Windows did not expose one unique, byte-identical original that can be deleted.`)
        if (objects.some(o => o.objectId === matches[0]!.objectId) || plans.some(p => p.objects.some(o => o.objectId === matches[0]!.objectId))) throw new Error('A Windows object was matched more than once.')
        objects.push(matches[0]!)
      }
      plans.push({item,files:checked.files,objects})
    } catch (e) { keep(item, (e as Error).message) }
  }
  for (const plan of plans) {
    try {
      if (deps.signal?.aborted) throw new Error('Stopped before iPhone deletion.')
      const currentPaths = await deps.paths(plan.item)
      if (currentPaths.length !== plan.files.length || currentPaths.some(p => !plan.files.some(f => f.devicePath === p))) throw new Error('The iPhone item gained or lost a component during verification.')
      for (const file of plan.files) {
        const current = await device.stat(file.devicePath)
        if (current.size !== file.size || current.mtimeMs !== file.sourceMtimeMs) throw new Error(`${file.name} changed after verification.`)
      }
      // If recording authorization fails, no delete call is made. The driver
      // then holds read-only backup handles while it rehashes and deletes.
      logDeletion(log, { at:new Date().toISOString(),phone:udid,item:`${plan.item.key}:verified-before-delete`,files:plan.files })
      deps.progress('deleting', plan.item.files[0]?.name ?? plan.item.key)
      const removed = await deps.remove(udid, plan.files.map((file,i) => ({object:plan.objects[i]!,sha256:file.sha256,bytes:file.size,destination:file.destination})), deps.signal)
      const complete = plan.objects.every(o => removed.deleted.has(o.objectId))
      if (!complete) throw new Error([...removed.failed.values()].join('; ') || 'Windows could not confirm deletion of every component. Some may already have been deleted; all saved copies remain intact.')
      result.deleted++
      try { logDeletion(log, {at:new Date().toISOString(),phone:udid,item:`${plan.item.key}:deleted`,files:plan.files}) }
      catch (e) { result.reasons.push({item:plan.item.key,reason:`Deletion was confirmed, but its final audit entry failed: ${(e as Error).message}`}) }
    } catch (e) { keep(plan.item, (e as Error).message) }
  }
  return result
}
