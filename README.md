# aoo-js

**Pure JavaScript implementation of the AOO (Audio over OSC) v2 protocol for real-time audio streaming.**

[![npm version](https://badge.fury.io/js/aoo-js.svg)](https://www.npmjs.com/package/aoo-js)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Stream audio in real-time using OSC over UDP. Compatible with Max/MSP `aoo_receive~` and Pure Data `aoo_receive~` objects.

## Features

- 🎵 **Real-time audio streaming** via UDP/OSC
- 🔗 **Compatible** with Max/MSP and Pure Data aoo externals
- ⚡ **Low latency** designed for live audio applications
- 📦 **Zero dependencies** for core functionality
- 🎛️ **Flexible** sample rate and channel configuration

## Installation

```bash
npm install aoo-js
```

## Quick Start

```javascript
const { AooSource } = require('aoo-js');

// Create an audio source
const source = new AooSource({
  channels: 2,
  sampleRate: 48000,
  blockSize: 512
});

// Add a sink (receiver) to stream to
source.addSink('127.0.0.1', 9999, 1);

// Start streaming
source.start();

// Send audio data (Float32Arrays)
source.sendAudio(leftChannelData, rightChannelData);

// Stop when done
source.stop();
source.close();
```

## API Reference

### `AooSource`

The main class for sending audio streams.

#### Constructor Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `channels` | number | 2 | Number of audio channels |
| `sampleRate` | number | 48000 | Sample rate in Hz |
| `blockSize` | number | 512 | Samples per block |
| `sourceId` | number | 1 | Unique source identifier |

#### Methods

##### `addSink(ip, port, sinkId)`
Add a receiver to stream audio to.

```javascript
source.addSink('127.0.0.1', 9999, 1);
```

##### `removeSink(ip, port)`
Remove a receiver.

##### `start()`
Start the audio stream. Sends `/start` message to all sinks.

##### `stop()`
Stop the audio stream. Sends `/stop` message to all sinks.

##### `sendAudio(...channels)`
Send audio data. Pass Float32Array for each channel.

```javascript
// Mono
source.sendAudio(monoData);

// Stereo
source.sendAudio(leftChannel, rightChannel);
```

##### `close()`
Close the UDP socket and clean up resources.

#### Events

```javascript
source.on('invite', (sinkIp, sinkPort, sinkId) => {
  console.log(`Sink ${sinkId} connected from ${sinkIp}:${sinkPort}`);
});

source.on('error', (error) => {
  console.error('Socket error:', error);
});
```

## Usage with Max/MSP

1. Create a patch with `aoo_receive~` object
2. Configure port (e.g., 9999) and sink ID (e.g., 1)
3. Connect output to `dac~`

```
[aoo_receive~ 9999 1]
|         |
[dac~ 1 2]
```

## Usage with Electron (Browser Audio)

```javascript
const { AooSource } = require('aoo-js');

// In preload.js - capture video audio
const audioContext = new AudioContext({ sampleRate: 48000 });
const source = new AooSource({ 
  sampleRate: audioContext.sampleRate 
});

source.addSink('127.0.0.1', 9999, 1);
source.start();

// Connect media element to aoo
const video = document.querySelector('video');
const mediaSource = audioContext.createMediaElementSource(video);
const processor = audioContext.createScriptProcessor(512, 2, 2);

processor.onaudioprocess = (e) => {
  const left = e.inputBuffer.getChannelData(0);
  const right = e.inputBuffer.getChannelData(1);
  source.sendAudio(left, right);
};

mediaSource.connect(processor);
processor.connect(audioContext.destination);
```

## Protocol Details

aoo-js implements the AOO v2 binary protocol:

### Message Format

| Bytes | Description |
|-------|-------------|
| 0-3 | Source ID (int32) |
| 4-7 | Sequence number (int32) |
| 8-11 | Sample rate (int32) |
| 12-13 | Block size (int16) |
| 14 | Channels (int8) |
| 15 | Codec ID (int8) |
| 16+ | PCM audio data (int16 interleaved) |

### OSC Messages

- `/aoo/src/<id>/data` - Audio data blob
- `/aoo/src/<id>/start` - Start stream
- `/aoo/src/<id>/stop` - Stop stream
- `/aoo/sink/<id>/invite` - Sink handshake

## Requirements

- Node.js 14+ or Electron
- UDP port access (firewall configuration may be needed)

## Related Projects

- [aoo](https://github.com/Spacechild1/aoo) - Original C/C++ implementation
- [Abletube](https://xterminatorapps.gumroad.com) - YouTube audio streaming for Ableton Live

## License

MIT © XTERMINATORAPPS

## Contributing

Contributions welcome! Please read the contributing guidelines first.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request
