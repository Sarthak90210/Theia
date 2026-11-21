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

Search uses EmbeddingGemma 2 by Google DeepMind, run on the device with
Transformers.js (Apache License 2.0, Hugging Face) and ONNX Runtime (MIT
License, Microsoft). Their license files are in resources/app/node_modules.
The model is the ONNX conversion published at
https://huggingface.co/onnx-community/embeddinggemma-2-ONNX, licensed under the
Apache License 2.0 (https://ai.google.dev/gemma/docs/gemma_4_license) and
subject to the Gemma Prohibited Use Policy
(https://ai.google.dev/gemma/prohibited_use_policy). Its files are in
resources/models/embeddinggemma-2, unmodified; provenance.json there records the
pinned revision and the verified SHA-256 of each file. Theia reads photos with it
only on this computer and sends nothing anywhere.

Reading text in photos uses PaddleOCR models by PaddlePaddle (Apache License
2.0, https://github.com/PaddlePaddle/PaddleOCR) in their ONNX conversions: the
PP-OCRv4 mobile text detector from https://huggingface.co/SWHL/RapidOCR
(RapidOCR, Apache License 2.0), and the PP-OCRv5 English and PP-OCRv3
Devanagari line readers with their character lists from
https://huggingface.co/monkt/paddleocr-onnx (Apache License 2.0). Their files
are in resources/models/ppocr, unmodified apart from their names;
provenance.json there records where each came from and its verified SHA-256.

Grouping faces into people uses two models from the OpenCV Zoo, in
resources/models/faces with their licence files and a provenance.json:
YuNet (https://huggingface.co/opencv/face_detection_yunet), MIT License,
Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>; and SFace
(https://huggingface.co/opencv/face_recognition_sface), Apache License 2.0,
contributed by Yaoyao Zhong. Faces are found and compared only on this
computer; nothing is sent anywhere.

The Liquid Glass interface uses three components from React Bits
(https://reactbits.dev): GlassSurface, GlassIcons and FluidGlass, in
resources/app/dist-app/renderer/app.js and app.css. Copyright (c) 2026 David
Haz, under the MIT + Commons Clause License Condition v1.0: they may be used,
including commercially, as part of an application, but not sold, sublicensed
or redistributed on their own, alone, in a bundle or as a ported version. The
full licence is at https://github.com/DavidHDev/react-bits/blob/main/LICENSE.md.
