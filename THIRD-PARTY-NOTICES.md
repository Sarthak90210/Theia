# Third-party software

Theia uses Electron, React, better-sqlite3, sharp, libheif-js,
exiftool-vendored and their dependencies. Their license files are retained
in the installed app's resources/app/node_modules directories. Electron's
LICENSE.electron.txt and LICENSES.chromium.html are included beside Theia.exe.

FFmpeg and FFprobe are separate command-line programs distributed with Theia.
They are licensed under the GNU General Public License version 3. The license
and upstream README are in resources/bin. Theia invokes these executables for
video thumbnails, playback conversion, verification and edited video copies.

The Windows x64 tools are the unmodified Gyan release essentials build of
FFmpeg 9.0.2:

- Binary distribution and build information: https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2
- Corresponding FFmpeg source: https://github.com/FFmpeg/FFmpeg/commit/946fcce07b
- Source archive: https://github.com/FFmpeg/FFmpeg/archive/946fcce07b.tar.gz
- Build configuration and included libraries: https://www.gyan.dev/ffmpeg/builds/
- FFmpeg project and licensing information: https://ffmpeg.org/legal.html

The bundled resources/bin/provenance.json records the distribution URL and
verified SHA-256 of the downloaded build. Source and license terms for linked
libraries are available through the upstream build and FFmpeg source links.

The Windows photo-cleanup helper includes the MIT-licensed MediaDevices 1.10.2
library from https://github.com/Bassman2/MediaDevices. Its DLL, MIT license and
pinned NuGet distribution details are in resources/app/dist-app/wpd. This
helper uses Windows Portable Devices for identity, content reads and deletion;
Theia does not unlink photo files over AFC or edit the iPhone Photos database.
