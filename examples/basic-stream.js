/**
 * Basic AOO streaming example
 * 
 * This example creates a simple stereo audio stream and sends it to a receiver.
 * Use with Max/MSP aoo_receive~ or Pure Data aoo_receive~ object.
 */

const { AooSource } = require('../src');

// Create audio source
const source = new AooSource({
    channels: 2,
    sampleRate: 48000,
    blockSize: 512,
    sourceId: 1,
    localPort: 9998
});

// Add sink (receiver) - change IP and port to match your setup
source.addSink('127.0.0.1', 9999, 1);

console.log('AOO Source started');
console.log('Streaming to 127.0.0.1:9999');
console.log('Press Ctrl+C to stop');

// Start streaming
source.start();

// Generate test tone (440Hz sine wave)
const sampleRate = 48000;
const frequency = 440;
const blockSize = 512;

let phase = 0;

setInterval(() => {
    const left = new Float32Array(blockSize);
    const right = new Float32Array(blockSize);

    for (let i = 0; i < blockSize; i++) {
        const sample = Math.sin(phase * 2 * Math.PI);
        left[i] = sample * 0.5;  // Left channel
        right[i] = sample * 0.5; // Right channel
        phase += frequency / sampleRate;
        if (phase >= 1) phase -= 1;
    }

    source.sendAudio(left, right);
}, (blockSize / sampleRate) * 1000);

// Handle exit
process.on('SIGINT', () => {
    console.log('\nStopping...');
    source.stop();
    source.close();
    process.exit(0);
});
