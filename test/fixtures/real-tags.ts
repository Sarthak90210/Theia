import type { RawTags } from '../../src/metadata/tags.ts'

/**
 * Tag values copied verbatim from a real iPhone 16 Pro Max on iOS 27, read with
 * `exiftool -G1 -n`. Invented fixtures would let a wrong assumption about group
 * names or value shapes pass unnoticed, which is the bug that already bit this
 * project once.
 *
 * These live outside any *.test.ts file on purpose. Exporting them from a test
 * file made vitest re-execute that file for every importer, so its tests ran
 * three times and the reported total was inflated by 37.
 */

export const REAL_HEIC: RawTags = {
  'File:ImageWidth': 5712,
  'File:ImageHeight': 4284,
  'IFD0:Make': 'Apple',
  'IFD0:Model': 'iPhone 16 Pro Max',
  'IFD0:Orientation': 6,
  'ExifIFD:DateTimeOriginal': '2026:06:08 18:26:19',
  'ExifIFD:CreateDate': '2026:06:08 18:26:19',
  'ExifIFD:OffsetTime': '+09:00',
  'ExifIFD:OffsetTimeOriginal': '+09:00',
  'ExifIFD:LensModel': 'iPhone 16 Pro Max back triple camera 6.765mm f/1.78',
  'ExifIFD:ISO': 80,
  'ExifIFD:FNumber': 1.78,
  'ExifIFD:ExposureTime': 0.01,
  'ExifIFD:FocalLength': 6.765,
  'Apple:ContentIdentifier': '4B23D938-CC54-4D95-B0F6-55FE602F2CDA',
  'GPS:GPSLatitudeRef': 'N',
  'GPS:GPSLatitude': 35.6565388888889,
  'GPS:GPSLongitudeRef': 'E',
  'GPS:GPSLongitude': 139.702530555556,
  'Composite:SubSecDateTimeOriginal': '2026:06:08 18:26:19.698+09:00',
  'Composite:GPSLatitude': 35.6565388888889,
  'Composite:GPSLongitude': 139.702530555556,
  'Composite:GPSAltitude': 17.59094717,
  'MWG:Orientation': 6,
}

export const REAL_MOV: RawTags = {
  'QuickTime:CreateDate': '2026:06:08 09:26:19',
  'QuickTime:Duration': 0.1,
  'Track1:ImageWidth': 1920,
  'Track1:ImageHeight': 1440,
  'Track1:MediaCreateDate': '2026:06:08 09:26:19',
  'VideoKeys:LensModel': 'iPhone 16 Pro Max back camera 6.765mm f/1.78',
  'Keys:ContentIdentifier': '4B23D938-CC54-4D95-B0F6-55FE602F2CDA',
  'Keys:CreationDate': '2026:06:08 18:26:19+09:00',
  'Composite:GPSLatitude': 35.6565,
  'Composite:GPSLongitude': 139.7025,
  'Composite:GPSAltitude': 17.591,
  'Composite:ImageSize': '1920 1440',
  'Composite:Rotation': 90,
}
