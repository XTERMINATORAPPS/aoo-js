# aoo-js - AOO (Audio over OSC) Implementation Plan

## Overview
Pure JavaScript implementation of the AOO v2 protocol for real-time audio streaming.
Compatible with Max/MSP `aoo_receive~` and Pure Data `aoo_receive~` objects.

---

## Project Structure
```
aoo-js/
├── src/
│   ├── index.js           # Main entry point
│   ├── aoo-source.js      # Audio source (sender)
│   └── aoo-sink.js        # Audio sink (receiver) - future
├── examples/
│   ├── basic-stream.js    # Simple stereo stream example
│   ├── file-stream.js     # Stream audio file
│   └── microphone.js      # Stream microphone input
├── test/
│   └── aoo-source.test.js # Unit tests
├── README.md
├── package.json
├── LICENSE (MIT)
└── .gitignore
```

---

## Features to Implement

### Phase 1: Core (Current)
- [x] AOO v2 binary data message format
- [x] OSC message building (/start, /ping, /pong)
- [x] UDP socket management
- [x] Dynamic sample rate detection
- [x] Sink handshake (/invite response)

### Phase 2: Cleanup
- [ ] Remove minification (readable source)
- [ ] Add JSDoc comments
- [ ] Add TypeScript types
- [ ] Create npm package.json

### Phase 3: Examples
- [ ] Basic streaming example
- [ ] Electron browser audio capture
- [ ] Node.js microphone capture

### Phase 4: Documentation
- [ ] API documentation
- [ ] Protocol specification
- [ ] Max/MSP setup guide

### Phase 5: Publishing
- [ ] Create GitHub repository
- [ ] Publish to npm as `aoo-js`
- [ ] Add CI/CD for tests

---

## API Design

```javascript
const { AooSource } = require('aoo-js');

const source = new AooSource({
  channels: 2,
  sampleRate: 48000,
  blockSize: 512
});

source.addSink('127.0.0.1', 9999, 1);
source.start();
source.sendAudio(leftChannel, rightChannel);
source.stop();
source.close();
```

---

## Repository Info
- **Name:** `aoo-js`
- **License:** MIT
- **Keywords:** aoo, audio, osc, udp, streaming, max-msp, puredata
