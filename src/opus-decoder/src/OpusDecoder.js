import { WASMAudioDecoderCommon } from "@wasm-audio-decoders/common";

import EmscriptenWASM from "./EmscriptenWasm.js";

export default class OpusDecoder {
  constructor(options = {}) {
    // injects dependencies when running as a web worker
    this._isWebWorker = this.constructor.isWebWorker;
    this._WASMAudioDecoderCommon =
      this.constructor.WASMAudioDecoderCommon || WASMAudioDecoderCommon;
    this._EmscriptenWASM = this.constructor.EmscriptenWASM || EmscriptenWASM;

    this._inputPtrSize = (0.12 * 510000) / 8;
    this._outputPtrSize = 120 * 48;
    this._outputChannels = 2;

    this._ready = this._init();
  }

  // injects dependencies when running as a web worker
  async _init() {
    this._common = await this._WASMAudioDecoderCommon.initWASMAudioDecoder.bind(
      this
    )();

    this._decoder = this._common.wasm._opus_frame_decoder_create();
  }

  get ready() {
    return this._ready;
  }

  async reset() {
    this.free();
    await this._init();
  }

  free() {
    this._common.wasm._opus_frame_decoder_destroy(this._decoder);

    this._common.free();
  }

  decodeFrame(opusFrame) {
    if (!(opusFrame instanceof Uint8Array))
      throw Error(
        `Data to decode must be Uint8Array. Instead got ${typeof opusFrame}`
      );

    this._input.set(opusFrame);

    const samplesDecoded =
      this._common.wasm._opus_frame_decode_float_deinterleaved(
        this._decoder,
        this._inputPtr,
        opusFrame.length,
        this._outputPtr
      );

    return this._WASMAudioDecoderCommon.getDecodedAudio(
      [
        this._output.slice(0, samplesDecoded),
        this._output.slice(samplesDecoded, samplesDecoded * 2),
      ],
      samplesDecoded,
      48000
    );
  }

  decodeFrames(opusFrames) {
    let left = [],
      right = [],
      samples = 0;

    opusFrames.forEach((frame) => {
      const { channelData, samplesDecoded } = this.decodeFrame(frame);

      left.push(channelData[0]);
      right.push(channelData[1]);
      samples += samplesDecoded;
    });

    return this._WASMAudioDecoderCommon.getDecodedAudioConcat(
      [left, right],
      samples,
      48000
    );
  }
}
