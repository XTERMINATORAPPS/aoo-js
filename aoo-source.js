const dgram = require('dgram');

const kAooBinMsgDomainBit = 0x80;
const kAooBinMsgCmdData = 0;
const kAooMsgTypeSink = 1;

class AooSource {
    constructor(options = {}) {
        this.channels = options.channels || 2;
        this.sampleRate = options.sampleRate || 48000;
        this.blockSize = options.blockSize || 256;
        this.sourceId = options.sourceId || 1;
        this.localPort = options.localPort || 9998;

        this.socket = dgram.createSocket('udp4');
        this.sinks = new Map();
        this.sequence = 0;
        this.streamId = (Date.now() & 0x7FFFFFFF);
        this.isStreaming = false;
        this.formatId = 0;
        this.sinkVersion = '2.0';

        this._startSent = false;
        this._detectedSampleRate = null;
        this.sampleBuffer = [];

        this.socket.on('message', (msg, rinfo) => {
            this._handleMessage(msg, rinfo);
        });

        this.socket.on('error', (err) => { });

        this.socket.bind(this.localPort, '0.0.0.0');
    }

    addSink(host, port, sinkId) {
        const key = `${host}:${port}:${sinkId}`;
        this.sinks.set(key, { host, port, sinkId, active: true });
    }

    start() {
        if (this.isStreaming) return;
        this.isStreaming = true;
        this.sequence = 0;
        this.sampleBuffer = [];
        this._startSent = false;
        this._detectedSampleRate = null;
    }

    _sendStartToAllSinks() {
        for (const sink of this.sinks.values()) {
            if (sink.active) {
                this._sendStartOSC(sink.host, sink.port, sink.sinkId);
            }
        }
        this._startSent = true;
    }

    stop() {
        this.isStreaming = false;
    }

    _setSampleRate(newRate) {
        if (this.sampleRate !== newRate) {
            this.sampleRate = newRate;
            this.formatId++;
        }
    }

    updateSampleRate(newRate) {
        if (!this._startSent) {
            this._setSampleRate(newRate);
            return;
        }
        if (this.sampleRate !== newRate) {
            this.sampleRate = newRate;
            this.formatId++;
            for (const sink of this.sinks.values()) {
                if (sink.active) {
                    this._sendStartOSC(sink.host, sink.port, sink.sinkId);
                }
            }
        }
    }

    sendAudio(left, right, sampleRate) {
        if (!this.isStreaming) return;

        if (!this._startSent) {
            if (sampleRate && sampleRate !== this.sampleRate) {
                this._setSampleRate(sampleRate);
            }
            this._sendStartToAllSinks();
        }

        const leftArr = Array.isArray(left) ? left : Array.from(left);
        const rightArr = Array.isArray(right) ? right : Array.from(right);

        for (let i = 0; i < leftArr.length; i++) {
            this.sampleBuffer.push(leftArr[i]);
            this.sampleBuffer.push(rightArr[i]);
        }

        const samplesPerBlock = this.blockSize * this.channels;
        while (this.sampleBuffer.length >= samplesPerBlock) {
            const block = this.sampleBuffer.splice(0, samplesPerBlock);
            this._sendBlock(block);
        }
    }

    _sendBlock(samples) {
        const audioBytes = Buffer.allocUnsafe(samples.length * 4);
        for (let i = 0; i < samples.length; i++) {
            audioBytes.writeFloatBE(samples[i], i * 4);
        }

        for (const sink of this.sinks.values()) {
            const msg = this._buildDataMessage(sink, audioBytes);
            this.socket.send(msg, sink.port, sink.host);
        }

        this.sequence++;
        if (this.sequence >= 0x7FFFFFFF) {
            this.sequence = 0;
        }
    }

    _buildDataMessage(sink, audioData) {
        const totalSize = 4 + 12 + audioData.length;
        const msg = Buffer.allocUnsafe(totalSize);
        let offset = 0;

        msg.writeUInt8(kAooMsgTypeSink | kAooBinMsgDomainBit, offset++);
        msg.writeUInt8(kAooBinMsgCmdData, offset++);
        msg.writeUInt8(sink.sinkId & 0xFF, offset++);
        msg.writeUInt8(this.sourceId & 0xFF, offset++);

        msg.writeInt32BE(this.streamId, offset); offset += 4;
        msg.writeInt32BE(this.sequence, offset); offset += 4;
        msg.writeUInt8(0, offset++);
        msg.writeUInt8(0, offset++);
        msg.writeUInt16BE(audioData.length, offset); offset += 2;

        audioData.copy(msg, offset);
        return msg;
    }

    _sendStartOSC(host, port, sinkId) {
        const address = `/aoo/sink/${sinkId}/start`;
        const version = this.sinkVersion || '2.0';

        const msg = this._buildOSCMessage(address, [
            { type: 'i', value: this.sourceId },
            { type: 's', value: version },
            { type: 'i', value: this.streamId },
            { type: 'i', value: this.sequence },
            { type: 'i', value: this.formatId },
            { type: 'i', value: this.channels },
            { type: 'i', value: this.sampleRate },
            { type: 'i', value: this.blockSize },
            { type: 's', value: 'pcm' },
            { type: 'b', value: this._makePcmExtension() },
            { type: 't', value: BigInt(0) },
            { type: 'i', value: this.sampleRate / 10 },
            { type: 'i', value: 0 },
            { type: 'N', value: null },
            { type: 'N', value: null },
            { type: 'i', value: 0 },
        ]);

        this.socket.send(msg, port, host);
    }

    _makePcmExtension() {
        const buf = Buffer.alloc(4);
        buf.writeInt32BE(3, 0);
        return buf;
    }

    _buildOSCMessage(address, args) {
        const parts = [];

        const addrLen = Math.ceil((address.length + 1) / 4) * 4;
        const addrBuf = Buffer.alloc(addrLen);
        addrBuf.write(address, 0, 'ascii');
        parts.push(addrBuf);

        let typeTag = ',';
        for (const arg of args) typeTag += arg.type;
        const tagLen = Math.ceil((typeTag.length + 1) / 4) * 4;
        const tagBuf = Buffer.alloc(tagLen);
        tagBuf.write(typeTag, 0, 'ascii');
        parts.push(tagBuf);

        for (const arg of args) {
            switch (arg.type) {
                case 'i':
                    const iBuf = Buffer.alloc(4);
                    iBuf.writeInt32BE(arg.value, 0);
                    parts.push(iBuf);
                    break;
                case 's':
                    const sLen = Math.ceil((arg.value.length + 1) / 4) * 4;
                    const sBuf = Buffer.alloc(sLen);
                    sBuf.write(arg.value, 0, 'ascii');
                    parts.push(sBuf);
                    break;
                case 'b':
                    const blobLen = Math.ceil(arg.value.length / 4) * 4;
                    const bBuf = Buffer.alloc(4 + blobLen);
                    bBuf.writeInt32BE(arg.value.length, 0);
                    arg.value.copy(bBuf, 4);
                    parts.push(bBuf);
                    break;
                case 't':
                    const tBuf = Buffer.alloc(8);
                    tBuf.writeBigUInt64BE(arg.value, 0);
                    parts.push(tBuf);
                    break;
                case 'N':
                case 'T':
                case 'F':
                    break;
            }
        }

        return Buffer.concat(parts);
    }

    _handleMessage(msg, rinfo) {
        if (msg.length >= 4 && (msg[0] & kAooBinMsgDomainBit)) {
            return;
        }

        const nullIdx = msg.indexOf(0);
        if (nullIdx > 0) {
            const address = msg.toString('ascii', 0, nullIdx);

            if (address.includes('/invite')) {
                try {
                    const args = this._parseOscArgs(msg, nullIdx);
                    if (args.length >= 2) {
                        const token = args[1];
                        this.streamId = token;
                        this.formatId = 0;
                        this.sequence = 0;
                        this.addSink(rinfo.address, rinfo.port, 1);
                        this._sendStartOSC(rinfo.address, rinfo.port, 1);
                        this.start();
                    }
                } catch (e) { }
            }
            else if (address.includes('/start')) {
                try {
                    const args = this._parseOscArgs(msg, nullIdx);
                    if (args.length >= 2) {
                        this.sinkVersion = args[1];
                    }
                } catch (e) { }

                const sinkKey = `${rinfo.address}:${rinfo.port}:1`;
                if (!this.sinks.has(sinkKey)) {
                    this.addSink(rinfo.address, rinfo.port, 1);
                }
                this._sendStartOSC(rinfo.address, rinfo.port, 1);
            }
            else if (address.includes('/ping')) {
                this._sendPong(rinfo.address, rinfo.port, msg, nullIdx);
            }
        }
    }

    _sendPong(host, port, msg, nullIdx) {
        try {
            const args = this._parseOscArgs(msg, nullIdx);
            if (args.length >= 2) {
                const sinkId = args[0];
                const tt1 = args[1];
                const tt2 = BigInt(Date.now()) * BigInt(1000000);

                const pongAddr = `/aoo/sink/${sinkId}/pong`;
                const pongMsg = this._buildOSCMessage(pongAddr, [
                    { type: 'i', value: this.sourceId },
                    { type: 't', value: BigInt(tt1 || 0) },
                    { type: 't', value: tt2 }
                ]);
                this.socket.send(pongMsg, port, host);
            }
        } catch (e) { }
    }

    _parseOscArgs(buf, addressEnd) {
        const args = [];
        let offset = Math.ceil((addressEnd + 1) / 4) * 4;

        if (offset >= buf.length) return args;

        const typeTagEnd = buf.indexOf(0, offset);
        if (typeTagEnd === -1) return args;

        const typeTags = buf.toString('ascii', offset + 1, typeTagEnd);
        offset = Math.ceil((typeTagEnd + 1) / 4) * 4;

        for (const tag of typeTags) {
            if (offset >= buf.length) break;

            switch (tag) {
                case 'i':
                    args.push(buf.readInt32BE(offset));
                    offset += 4;
                    break;
                case 'f':
                    args.push(buf.readFloatBE(offset));
                    offset += 4;
                    break;
                case 's':
                    const strEnd = buf.indexOf(0, offset);
                    args.push(buf.toString('ascii', offset, strEnd));
                    offset = Math.ceil((strEnd + 1) / 4) * 4;
                    break;
                case 'b':
                    const size = buf.readInt32BE(offset);
                    offset += 4;
                    args.push(buf.slice(offset, offset + size));
                    offset = Math.ceil((offset + size) / 4) * 4;
                    break;
                case 'N':
                    args.push(null);
                    break;
                case 'T':
                    args.push(true);
                    break;
                case 'F':
                    args.push(false);
                    break;
            }
        }
        return args;
    }

    close() {
        this.stop();
        this.socket.close();
    }
}

module.exports = { AooSource };
