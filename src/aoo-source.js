/**
 * @fileoverview AOO (Audio over OSC) Source Implementation
 * 
 * This module implements the AOO v2 protocol for streaming real-time audio
 * over UDP using OSC (Open Sound Control) message format.
 * 
 * Compatible with:
 * - Max/MSP aoo_receive~ external
 * - Pure Data aoo_receive~ external
 * 
 * Protocol Reference: https://github.com/Spacechild1/aoo
 * 
 * @author XTERMINATORAPPS
 * @license MIT
 * @version 1.0.0
 */

const dgram = require('dgram');

// ============================================================================
// AOO Protocol Constants
// ============================================================================

/**
 * Binary message domain bit - indicates this is an AOO binary message
 * When set (0x80), the message contains raw audio data
 */
const kAooBinMsgDomainBit = 0x80;

/**
 * Binary message command type for audio data
 * Value 0 indicates this is audio sample data
 */
const kAooBinMsgCmdData = 0;

/**
 * Message type identifier for sink (receiver) messages
 * Value 1 indicates the message is destined for a sink
 */
const kAooMsgTypeSink = 1;

// ============================================================================
// AooSource Class
// ============================================================================

/**
 * AooSource - Audio streaming source using AOO v2 protocol
 * 
 * Creates a UDP socket that streams audio data to one or more AOO sinks.
 * Audio is encoded as 32-bit float PCM and sent in blocks.
 * 
 * @example
 * const source = new AooSource({
 *   channels: 2,
 *   sampleRate: 48000,
 *   blockSize: 512
 * });
 * 
 * source.addSink('127.0.0.1', 9999, 1);
 * source.start();
 * source.sendAudio(leftChannel, rightChannel);
 */
class AooSource {
    /**
     * Creates a new AOO audio source
     * 
     * @param {Object} options - Configuration options
     * @param {number} [options.channels=2] - Number of audio channels (1=mono, 2=stereo)
     * @param {number} [options.sampleRate=48000] - Sample rate in Hz
     * @param {number} [options.blockSize=256] - Samples per audio block
     * @param {number} [options.sourceId=1] - Unique identifier for this source
     * @param {number} [options.localPort=9998] - Local UDP port to bind to
     */
    constructor(options = {}) {
        // Audio format configuration
        this.channels = options.channels || 2;
        this.sampleRate = options.sampleRate || 48000;
        this.blockSize = options.blockSize || 256;
        this.sourceId = options.sourceId || 1;
        this.localPort = options.localPort || 9998;

        // Create UDP socket for sending/receiving OSC messages
        this.socket = dgram.createSocket('udp4');

        // Map of connected sinks (receivers) - key: "ip:port:sinkId"
        this.sinks = new Map();

        // Sequence number for audio packets (increments each block)
        this.sequence = 0;

        // Unique stream ID - generated from timestamp, used to identify this stream session
        this.streamId = (Date.now() & 0x7FFFFFFF);

        // Streaming state flag
        this.isStreaming = false;

        // Format ID - increments when audio format changes (sample rate, channels, etc.)
        this.formatId = 0;

        // AOO protocol version string for handshake
        this.sinkVersion = '2.0';

        // Internal state flags
        this._startSent = false;           // Whether /start message has been sent
        this._detectedSampleRate = null;   // Sample rate detected from incoming audio
        this.sampleBuffer = [];            // Buffer for accumulating samples before sending

        // Set up message handler for incoming OSC messages (invites, pings, etc.)
        this.socket.on('message', (msg, rinfo) => {
            this._handleMessage(msg, rinfo);
        });

        // Suppress socket errors (handled gracefully)
        this.socket.on('error', (err) => { });

        // Bind socket to local port to receive responses
        this.socket.bind(this.localPort, '0.0.0.0');
    }

    // ========================================================================
    // Sink Management
    // ========================================================================

    /**
     * Adds a sink (receiver) to stream audio to
     * 
     * @param {string} host - IP address of the sink (e.g., '127.0.0.1')
     * @param {number} port - UDP port of the sink
     * @param {number} sinkId - Unique sink identifier (must match receiver's ID)
     */
    addSink(host, port, sinkId) {
        const key = `${host}:${port}:${sinkId}`;
        this.sinks.set(key, { host, port, sinkId, active: true });
    }

    // ========================================================================
    // Stream Control
    // ========================================================================

    /**
     * Starts the audio stream
     * 
     * Initializes stream state and prepares for audio transmission.
     * The /start OSC message is sent on first audio block.
     */
    start() {
        if (this.isStreaming) return;
        this.isStreaming = true;
        this.sequence = 0;
        this.sampleBuffer = [];
        this._startSent = false;
        this._detectedSampleRate = null;
    }

    /**
     * Sends /start OSC message to all active sinks
     * 
     * This message informs receivers about the stream format:
     * - Sample rate, channels, block size
     * - Codec type (PCM)
     * - Stream and format IDs
     * 
     * @private
     */
    _sendStartToAllSinks() {
        for (const sink of this.sinks.values()) {
            if (sink.active) {
                this._sendStartOSC(sink.host, sink.port, sink.sinkId);
            }
        }
        this._startSent = true;
    }

    /**
     * Stops the audio stream
     * 
     * Sets streaming flag to false. Audio buffers are cleared on next start().
     */
    stop() {
        this.isStreaming = false;
    }

    /**
     * Internal method to update sample rate
     * Increments formatId to notify sinks of format change
     * 
     * @private
     * @param {number} newRate - New sample rate in Hz
     */
    _setSampleRate(newRate) {
        if (this.sampleRate !== newRate) {
            this.sampleRate = newRate;
            this.formatId++;
        }
    }

    /**
     * Updates the sample rate dynamically during streaming
     * 
     * If streaming has started, sends new /start message to all sinks
     * to notify them of the format change.
     * 
     * @param {number} newRate - New sample rate in Hz
     */
    updateSampleRate(newRate) {
        if (!this._startSent) {
            this._setSampleRate(newRate);
            return;
        }
        if (this.sampleRate !== newRate) {
            this.sampleRate = newRate;
            this.formatId++;
            // Notify all sinks of format change
            for (const sink of this.sinks.values()) {
                if (sink.active) {
                    this._sendStartOSC(sink.host, sink.port, sink.sinkId);
                }
            }
        }
    }

    // ========================================================================
    // Audio Data Transmission
    // ========================================================================

    /**
     * Sends audio data to all connected sinks
     * 
     * Audio samples are buffered and sent in blocks of size `blockSize`.
     * Interleaves stereo channels: [L0, R0, L1, R1, L2, R2, ...]
     * 
     * @param {Float32Array|Array} left - Left channel samples
     * @param {Float32Array|Array} right - Right channel samples
     * @param {number} [sampleRate] - Optional sample rate (for dynamic rate detection)
     */
    sendAudio(left, right, sampleRate) {
        if (!this.isStreaming) return;

        // Send /start message on first audio data
        if (!this._startSent) {
            if (sampleRate && sampleRate !== this.sampleRate) {
                this._setSampleRate(sampleRate);
            }
            this._sendStartToAllSinks();
        }

        // Convert to arrays if Float32Array
        const leftArr = Array.isArray(left) ? left : Array.from(left);
        const rightArr = Array.isArray(right) ? right : Array.from(right);

        // Interleave samples into buffer: [L, R, L, R, ...]
        for (let i = 0; i < leftArr.length; i++) {
            this.sampleBuffer.push(leftArr[i]);
            this.sampleBuffer.push(rightArr[i]);
        }

        // Send complete blocks
        const samplesPerBlock = this.blockSize * this.channels;
        while (this.sampleBuffer.length >= samplesPerBlock) {
            const block = this.sampleBuffer.splice(0, samplesPerBlock);
            this._sendBlock(block);
        }
    }

    /**
     * Sends a single audio block to all sinks
     * 
     * Converts float samples to big-endian 32-bit floats and
     * wraps in AOO binary data message format.
     * 
     * @private
     * @param {Array<number>} samples - Interleaved audio samples
     */
    _sendBlock(samples) {
        // Convert float samples to binary buffer (32-bit float, big-endian)
        const audioBytes = Buffer.allocUnsafe(samples.length * 4);
        for (let i = 0; i < samples.length; i++) {
            audioBytes.writeFloatBE(samples[i], i * 4);
        }

        // Send to all active sinks
        for (const sink of this.sinks.values()) {
            const msg = this._buildDataMessage(sink, audioBytes);
            this.socket.send(msg, sink.port, sink.host);
        }

        // Increment sequence number (wraps at max int32)
        this.sequence++;
        if (this.sequence >= 0x7FFFFFFF) {
            this.sequence = 0;
        }
    }

    // ========================================================================
    // AOO Binary Message Building
    // ========================================================================

    /**
     * Builds an AOO v2 binary data message
     * 
     * Binary message format (bytes):
     *   0: Message type (sink) | domain bit (0x80)
     *   1: Command (data = 0)
     *   2: Sink ID
     *   3: Source ID
     *   4-7: Stream ID (int32 BE)
     *   8-11: Sequence number (int32 BE)
     *   12: Reserved (0)
     *   13: Reserved (0)
     *   14-15: Audio data length (uint16 BE)
     *   16+: Audio data (PCM float32 BE)
     * 
     * @private
     * @param {Object} sink - Sink configuration {host, port, sinkId}
     * @param {Buffer} audioData - Raw audio bytes
     * @returns {Buffer} Complete binary message
     */
    _buildDataMessage(sink, audioData) {
        const totalSize = 4 + 12 + audioData.length;  // Header (4) + metadata (12) + audio
        const msg = Buffer.allocUnsafe(totalSize);
        let offset = 0;

        // Byte 0: Message type with domain bit set (binary message indicator)
        msg.writeUInt8(kAooMsgTypeSink | kAooBinMsgDomainBit, offset++);

        // Byte 1: Command type (0 = audio data)
        msg.writeUInt8(kAooBinMsgCmdData, offset++);

        // Byte 2: Sink ID (destination)
        msg.writeUInt8(sink.sinkId & 0xFF, offset++);

        // Byte 3: Source ID (sender)
        msg.writeUInt8(this.sourceId & 0xFF, offset++);

        // Bytes 4-7: Stream ID (identifies this streaming session)
        msg.writeInt32BE(this.streamId, offset); offset += 4;

        // Bytes 8-11: Sequence number (for ordering/loss detection)
        msg.writeInt32BE(this.sequence, offset); offset += 4;

        // Bytes 12-13: Reserved fields
        msg.writeUInt8(0, offset++);
        msg.writeUInt8(0, offset++);

        // Bytes 14-15: Audio data length
        msg.writeUInt16BE(audioData.length, offset); offset += 2;

        // Bytes 16+: Audio data
        audioData.copy(msg, offset);

        return msg;
    }

    // ========================================================================
    // OSC Message Building & Sending
    // ========================================================================

    /**
     * Sends OSC /start message to a sink
     * 
     * This message contains full stream format information:
     * - Source ID, version, stream ID, sequence, format ID
     * - Channel count, sample rate, block size
     * - Codec type ("pcm") with extension data
     * - Timing and buffer information
     * 
     * @private
     * @param {string} host - Sink IP address
     * @param {number} port - Sink UDP port
     * @param {number} sinkId - Sink identifier
     */
    _sendStartOSC(host, port, sinkId) {
        const address = `/aoo/sink/${sinkId}/start`;
        const version = this.sinkVersion || '2.0';

        // Build OSC message with all format parameters
        const msg = this._buildOSCMessage(address, [
            { type: 'i', value: this.sourceId },          // Source ID
            { type: 's', value: version },                 // Protocol version
            { type: 'i', value: this.streamId },          // Stream session ID
            { type: 'i', value: this.sequence },          // Current sequence
            { type: 'i', value: this.formatId },          // Format version
            { type: 'i', value: this.channels },          // Channel count
            { type: 'i', value: this.sampleRate },        // Sample rate (Hz)
            { type: 'i', value: this.blockSize },         // Samples per block
            { type: 's', value: 'pcm' },                  // Codec name
            { type: 'b', value: this._makePcmExtension() }, // Codec extension (bit depth)
            { type: 't', value: BigInt(0) },              // Timestamp
            { type: 'i', value: this.sampleRate / 10 },   // Reblock size
            { type: 'i', value: 0 },                      // Reserved
            { type: 'N', value: null },                   // Null (metadata)
            { type: 'N', value: null },                   // Null (metadata)
            { type: 'i', value: 0 },                      // Flags
        ]);

        this.socket.send(msg, port, host);
    }

    /**
     * Creates PCM codec extension data
     * 
     * Extension specifies bit depth:
     *   3 = 32-bit float (used by this implementation)
     * 
     * @private
     * @returns {Buffer} 4-byte extension data
     */
    _makePcmExtension() {
        const buf = Buffer.alloc(4);
        buf.writeInt32BE(3, 0);  // 3 = float32 format
        return buf;
    }

    /**
     * Builds a complete OSC message from address and arguments
     * 
     * OSC message format:
     *   1. Address pattern (null-terminated, padded to 4 bytes)
     *   2. Type tag string (comma + types, null-terminated, padded to 4 bytes)
     *   3. Arguments (each padded to 4 bytes as needed)
     * 
     * Supported types:
     *   'i' - int32
     *   's' - string
     *   'b' - blob (binary data)
     *   't' - timetag (uint64)
     *   'N' - null
     *   'T' - true
     *   'F' - false
     * 
     * @private
     * @param {string} address - OSC address pattern (e.g., "/aoo/sink/1/start")
     * @param {Array<Object>} args - Array of {type, value} objects
     * @returns {Buffer} Complete OSC message
     */
    _buildOSCMessage(address, args) {
        const parts = [];

        // Address pattern (padded to 4-byte boundary)
        const addrLen = Math.ceil((address.length + 1) / 4) * 4;
        const addrBuf = Buffer.alloc(addrLen);
        addrBuf.write(address, 0, 'ascii');
        parts.push(addrBuf);

        // Type tag string: comma followed by type characters
        let typeTag = ',';
        for (const arg of args) typeTag += arg.type;
        const tagLen = Math.ceil((typeTag.length + 1) / 4) * 4;
        const tagBuf = Buffer.alloc(tagLen);
        tagBuf.write(typeTag, 0, 'ascii');
        parts.push(tagBuf);

        // Arguments - each encoded according to its type
        for (const arg of args) {
            switch (arg.type) {
                case 'i':  // 32-bit integer (big-endian)
                    const iBuf = Buffer.alloc(4);
                    iBuf.writeInt32BE(arg.value, 0);
                    parts.push(iBuf);
                    break;

                case 's':  // String (null-terminated, padded to 4 bytes)
                    const sLen = Math.ceil((arg.value.length + 1) / 4) * 4;
                    const sBuf = Buffer.alloc(sLen);
                    sBuf.write(arg.value, 0, 'ascii');
                    parts.push(sBuf);
                    break;

                case 'b':  // Blob (4-byte length prefix + data, padded)
                    const blobLen = Math.ceil(arg.value.length / 4) * 4;
                    const bBuf = Buffer.alloc(4 + blobLen);
                    bBuf.writeInt32BE(arg.value.length, 0);
                    arg.value.copy(bBuf, 4);
                    parts.push(bBuf);
                    break;

                case 't':  // Timetag (64-bit, big-endian)
                    const tBuf = Buffer.alloc(8);
                    tBuf.writeBigUInt64BE(arg.value, 0);
                    parts.push(tBuf);
                    break;

                case 'N':  // Null - no data bytes
                case 'T':  // True - no data bytes
                case 'F':  // False - no data bytes
                    break;
            }
        }

        return Buffer.concat(parts);
    }

    // ========================================================================
    // Incoming Message Handling
    // ========================================================================

    /**
     * Handles incoming OSC messages from sinks
     * 
     * Responds to:
     *   /invite - Sink requesting to receive audio
     *   /start  - Sink confirming stream start
     *   /ping   - Keep-alive ping (responds with pong)
     * 
     * @private
     * @param {Buffer} msg - Raw UDP message
     * @param {Object} rinfo - Remote address info {address, port}
     */
    _handleMessage(msg, rinfo) {
        // Ignore binary data messages (we're a source, not sink)
        if (msg.length >= 4 && (msg[0] & kAooBinMsgDomainBit)) {
            return;
        }

        // Find address string (null-terminated)
        const nullIdx = msg.indexOf(0);
        if (nullIdx > 0) {
            const address = msg.toString('ascii', 0, nullIdx);

            // Handle /invite - sink wants to receive our audio
            if (address.includes('/invite')) {
                try {
                    const args = this._parseOscArgs(msg, nullIdx);
                    if (args.length >= 2) {
                        const token = args[1];
                        this.streamId = token;  // Use sink's token as stream ID
                        this.formatId = 0;
                        this.sequence = 0;
                        this.addSink(rinfo.address, rinfo.port, 1);
                        this._sendStartOSC(rinfo.address, rinfo.port, 1);
                        this.start();
                    }
                } catch (e) { }
            }
            // Handle /start - sink acknowledging our stream
            else if (address.includes('/start')) {
                try {
                    const args = this._parseOscArgs(msg, nullIdx);
                    if (args.length >= 2) {
                        this.sinkVersion = args[1];  // Store sink's protocol version
                    }
                } catch (e) { }

                // Ensure this sink is in our list
                const sinkKey = `${rinfo.address}:${rinfo.port}:1`;
                if (!this.sinks.has(sinkKey)) {
                    this.addSink(rinfo.address, rinfo.port, 1);
                }
                this._sendStartOSC(rinfo.address, rinfo.port, 1);
            }
            // Handle /ping - keep-alive request
            else if (address.includes('/ping')) {
                this._sendPong(rinfo.address, rinfo.port, msg, nullIdx);
            }
        }
    }

    /**
     * Sends a /pong response to a /ping request
     * 
     * Pong includes timing information for latency measurement:
     *   - Original ping timestamp (tt1)
     *   - Current time at response (tt2)
     * 
     * @private
     * @param {string} host - Sender's IP address
     * @param {number} port - Sender's UDP port
     * @param {Buffer} msg - Original ping message
     * @param {number} nullIdx - Index of null terminator in address
     */
    _sendPong(host, port, msg, nullIdx) {
        try {
            const args = this._parseOscArgs(msg, nullIdx);
            if (args.length >= 2) {
                const sinkId = args[0];
                const tt1 = args[1];  // Ping timestamp
                const tt2 = BigInt(Date.now()) * BigInt(1000000);  // Current time (nanoseconds)

                const pongAddr = `/aoo/sink/${sinkId}/pong`;
                const pongMsg = this._buildOSCMessage(pongAddr, [
                    { type: 'i', value: this.sourceId },
                    { type: 't', value: BigInt(tt1 || 0) },  // Echo back ping time
                    { type: 't', value: tt2 }                 // Our current time
                ]);
                this.socket.send(pongMsg, port, host);
            }
        } catch (e) { }
    }

    // ========================================================================
    // OSC Message Parsing
    // ========================================================================

    /**
     * Parses OSC message arguments from a buffer
     * 
     * Reads type tags and extracts corresponding values.
     * 
     * @private
     * @param {Buffer} buf - OSC message buffer
     * @param {number} addressEnd - Index where address string ends
     * @returns {Array} Parsed argument values
     */
    _parseOscArgs(buf, addressEnd) {
        const args = [];

        // Skip past address (padded to 4 bytes)
        let offset = Math.ceil((addressEnd + 1) / 4) * 4;

        if (offset >= buf.length) return args;

        // Find type tag string
        const typeTagEnd = buf.indexOf(0, offset);
        if (typeTagEnd === -1) return args;

        // Type tags start after comma
        const typeTags = buf.toString('ascii', offset + 1, typeTagEnd);
        offset = Math.ceil((typeTagEnd + 1) / 4) * 4;

        // Parse each argument according to its type
        for (const tag of typeTags) {
            if (offset >= buf.length) break;

            switch (tag) {
                case 'i':  // 32-bit integer
                    args.push(buf.readInt32BE(offset));
                    offset += 4;
                    break;

                case 'f':  // 32-bit float
                    args.push(buf.readFloatBE(offset));
                    offset += 4;
                    break;

                case 's':  // String (null-terminated)
                    const strEnd = buf.indexOf(0, offset);
                    args.push(buf.toString('ascii', offset, strEnd));
                    offset = Math.ceil((strEnd + 1) / 4) * 4;
                    break;

                case 'b':  // Blob (length-prefixed binary)
                    const size = buf.readInt32BE(offset);
                    offset += 4;
                    args.push(buf.slice(offset, offset + size));
                    offset = Math.ceil((offset + size) / 4) * 4;
                    break;

                case 'N':  // Null
                    args.push(null);
                    break;

                case 'T':  // True
                    args.push(true);
                    break;

                case 'F':  // False
                    args.push(false);
                    break;
            }
        }
        return args;
    }

    // ========================================================================
    // Cleanup
    // ========================================================================

    /**
     * Closes the audio source and releases resources
     * 
     * Stops streaming and closes the UDP socket.
     * The source cannot be used after calling close().
     */
    close() {
        this.stop();
        this.socket.close();
    }
}

// Export the AooSource class
module.exports = { AooSource };
