(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports, require('web-worker')) :
  typeof define === 'function' && define.amd ? define(['exports', 'web-worker'], factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global["opus-decoder"] = {}, global.Worker));
})(this, (function (exports, Worker) { 'use strict';

  function _interopDefaultLegacy (e) { return e && typeof e === 'object' && 'default' in e ? e : { 'default': e }; }

  var Worker__default = /*#__PURE__*/_interopDefaultLegacy(Worker);

  const compiledWasm = new WeakMap();

  class WASMAudioDecoderCommon {
    constructor(wasm) {
      this._wasm = wasm;

      this._pointers = new Set();
    }

    get wasm() {
      return this._wasm;
    }

    static async initWASMAudioDecoder() {
      // instantiate wasm code as singleton
      if (!this._wasm) {
        // new decoder instance
        if (this._isWebWorker) {
          // web worker
          this._wasm = new this._EmscriptenWASM(WASMAudioDecoderCommon);
        } else {
          // main thread
          if (compiledWasm.has(this._EmscriptenWASM)) {
            // reuse existing compilation
            this._wasm = compiledWasm.get(this._EmscriptenWASM);
          } else {
            // first compilation
            this._wasm = new this._EmscriptenWASM(WASMAudioDecoderCommon);
            compiledWasm.set(this._EmscriptenWASM, this._wasm);
          }
        }
      }

      await this._wasm.ready;

      const common = new WASMAudioDecoderCommon(this._wasm);

      [this._inputPtr, this._input] = common.allocateTypedArray(
        this._inputPtrSize,
        Uint8Array
      );

      // output buffer
      [this._outputPtr, this._output] = common.allocateTypedArray(
        this._outputChannels * this._outputPtrSize,
        Float32Array
      );

      return common;
    }

    static concatFloat32(buffers, length) {
      const ret = new Float32Array(length);

      let offset = 0;
      for (const buf of buffers) {
        ret.set(buf, offset);
        offset += buf.length;
      }

      return ret;
    }

    static getDecodedAudio(channelData, samplesDecoded, sampleRate) {
      return {
        channelData,
        samplesDecoded,
        sampleRate,
      };
    }

    static getDecodedAudioConcat(channelData, samplesDecoded, sampleRate) {
      return WASMAudioDecoderCommon.getDecodedAudio(
        channelData.map((data) =>
          WASMAudioDecoderCommon.concatFloat32(data, samplesDecoded)
        ),
        samplesDecoded,
        sampleRate
      );
    }

    static getDecodedAudioMultiChannel(
      input,
      channelsDecoded,
      samplesDecoded,
      sampleRate
    ) {
      const channelData = [];

      for (let i = 0; i < channelsDecoded; i++) {
        const channel = [];
        for (let j = 0; j < input.length; j++) {
          channel.push(input[j][i]);
        }
        channelData.push(
          WASMAudioDecoderCommon.concatFloat32(channel, samplesDecoded)
        );
      }

      return WASMAudioDecoderCommon.getDecodedAudio(
        channelData,
        samplesDecoded,
        sampleRate
      );
    }

    getOutputChannels(outputData, channelsDecoded, samplesDecoded) {
      const output = [];

      for (let i = 0; i < channelsDecoded; i++)
        output.push(
          outputData.slice(
            i * samplesDecoded,
            i * samplesDecoded + samplesDecoded
          )
        );

      return output;
    }

    allocateTypedArray(length, TypedArray) {
      const pointer = this._wasm._malloc(TypedArray.BYTES_PER_ELEMENT * length);
      const array = new TypedArray(this._wasm.HEAP, pointer, length);

      this._pointers.add(pointer);
      return [pointer, array];
    }

    free() {
      for (const pointer of this._pointers) this._wasm._free(pointer);
      this._pointers.clear();
    }

    /*
     ******************
     * Compression Code
     ******************
     */

    static inflateYencString(source, dest) {
      const output = new Uint8Array(source.length);

      let continued = false,
        byteIndex = 0,
        byte;

      for (let i = 0; i < source.length; i++) {
        byte = source.charCodeAt(i);

        if (byte === 13 || byte === 10) continue;

        if (byte === 61 && !continued) {
          continued = true;
          continue;
        }

        if (continued) {
          continued = false;
          byte -= 64;
        }

        output[byteIndex++] = byte < 42 && byte > 0 ? byte + 214 : byte - 42;
      }

      return WASMAudioDecoderCommon.inflate(output.subarray(0, byteIndex), dest);
    }

    static inflate(source, dest) {
      const TINF_OK = 0;
      const TINF_DATA_ERROR = -3;

      const uint8Array = Uint8Array;
      const uint16Array = Uint16Array;

      class Tree {
        constructor() {
          this.t = new uint16Array(16); /* table of code length counts */
          this.trans = new uint16Array(
            288
          ); /* code -> symbol translation table */
        }
      }

      class Data {
        constructor(source, dest) {
          this.s = source;
          this.i = 0;
          this.t = 0;
          this.bitcount = 0;

          this.dest = dest;
          this.destLen = 0;

          this.ltree = new Tree(); /* dynamic length/symbol tree */
          this.dtree = new Tree(); /* dynamic distance tree */
        }
      }

      /* --------------------------------------------------- *
       * -- uninitialized global data (static structures) -- *
       * --------------------------------------------------- */

      const sltree = new Tree();
      const sdtree = new Tree();

      /* extra bits and base tables for length codes */
      const length_bits = new uint8Array(30);
      const length_base = new uint16Array(30);

      /* extra bits and base tables for distance codes */
      const dist_bits = new uint8Array(30);
      const dist_base = new uint16Array(30);

      /* special ordering of code length codes */
      const clcidx = new uint8Array([
        16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
      ]);

      /* used by tinf_decode_trees, avoids allocations every call */
      const code_tree = new Tree();
      const lengths = new uint8Array(288 + 32);

      /* ----------------------- *
       * -- utility functions -- *
       * ----------------------- */

      /* build extra bits and base tables */
      const tinf_build_bits_base = (bits, base, delta, first) => {
        let i, sum;

        /* build bits table */
        for (i = 0; i < delta; ++i) bits[i] = 0;
        for (i = 0; i < 30 - delta; ++i) bits[i + delta] = (i / delta) | 0;

        /* build base table */
        for (sum = first, i = 0; i < 30; ++i) {
          base[i] = sum;
          sum += 1 << bits[i];
        }
      };

      /* build the fixed huffman trees */
      const tinf_build_fixed_trees = (lt, dt) => {
        let i;

        /* build fixed length tree */
        for (i = 0; i < 7; ++i) lt.t[i] = 0;

        lt.t[7] = 24;
        lt.t[8] = 152;
        lt.t[9] = 112;

        for (i = 0; i < 24; ++i) lt.trans[i] = 256 + i;
        for (i = 0; i < 144; ++i) lt.trans[24 + i] = i;
        for (i = 0; i < 8; ++i) lt.trans[24 + 144 + i] = 280 + i;
        for (i = 0; i < 112; ++i) lt.trans[24 + 144 + 8 + i] = 144 + i;

        /* build fixed distance tree */
        for (i = 0; i < 5; ++i) dt.t[i] = 0;

        dt.t[5] = 32;

        for (i = 0; i < 32; ++i) dt.trans[i] = i;
      };

      /* given an array of code lengths, build a tree */
      const offs = new uint16Array(16);

      const tinf_build_tree = (t, lengths, off, num) => {
        let i, sum;

        /* clear code length count table */
        for (i = 0; i < 16; ++i) t.t[i] = 0;

        /* scan symbol lengths, and sum code length counts */
        for (i = 0; i < num; ++i) t.t[lengths[off + i]]++;

        t.t[0] = 0;

        /* compute offset table for distribution sort */
        for (sum = 0, i = 0; i < 16; ++i) {
          offs[i] = sum;
          sum += t.t[i];
        }

        /* create code->symbol translation table (symbols sorted by code) */
        for (i = 0; i < num; ++i) {
          if (lengths[off + i]) t.trans[offs[lengths[off + i]]++] = i;
        }
      };

      /* ---------------------- *
       * -- decode functions -- *
       * ---------------------- */

      /* get one bit from source stream */
      const tinf_getbit = (d) => {
        /* check if tag is empty */
        if (!d.bitcount--) {
          /* load next tag */
          d.t = d.s[d.i++];
          d.bitcount = 7;
        }

        /* shift bit out of tag */
        const bit = d.t & 1;
        d.t >>>= 1;

        return bit;
      };

      /* read a num bit value from a stream and add base */
      const tinf_read_bits = (d, num, base) => {
        if (!num) return base;

        while (d.bitcount < 24) {
          d.t |= d.s[d.i++] << d.bitcount;
          d.bitcount += 8;
        }

        const val = d.t & (0xffff >>> (16 - num));
        d.t >>>= num;
        d.bitcount -= num;
        return val + base;
      };

      /* given a data stream and a tree, decode a symbol */
      const tinf_decode_symbol = (d, t) => {
        while (d.bitcount < 24) {
          d.t |= d.s[d.i++] << d.bitcount;
          d.bitcount += 8;
        }

        let sum = 0,
          cur = 0,
          len = 0,
          tag = d.t;

        /* get more bits while code value is above sum */
        do {
          cur = 2 * cur + (tag & 1);
          tag >>>= 1;
          ++len;

          sum += t.t[len];
          cur -= t.t[len];
        } while (cur >= 0);

        d.t = tag;
        d.bitcount -= len;

        return t.trans[sum + cur];
      };

      /* given a data stream, decode dynamic trees from it */
      const tinf_decode_trees = (d, lt, dt) => {
        let i, length;

        /* get 5 bits HLIT (257-286) */
        const hlit = tinf_read_bits(d, 5, 257);

        /* get 5 bits HDIST (1-32) */
        const hdist = tinf_read_bits(d, 5, 1);

        /* get 4 bits HCLEN (4-19) */
        const hclen = tinf_read_bits(d, 4, 4);

        for (i = 0; i < 19; ++i) lengths[i] = 0;

        /* read code lengths for code length alphabet */
        for (i = 0; i < hclen; ++i) {
          /* get 3 bits code length (0-7) */
          const clen = tinf_read_bits(d, 3, 0);
          lengths[clcidx[i]] = clen;
        }

        /* build code length tree */
        tinf_build_tree(code_tree, lengths, 0, 19);

        /* decode code lengths for the dynamic trees */
        for (let num = 0; num < hlit + hdist; ) {
          const sym = tinf_decode_symbol(d, code_tree);

          switch (sym) {
            case 16:
              /* copy previous code length 3-6 times (read 2 bits) */
              const prev = lengths[num - 1];
              for (length = tinf_read_bits(d, 2, 3); length; --length) {
                lengths[num++] = prev;
              }
              break;
            case 17:
              /* repeat code length 0 for 3-10 times (read 3 bits) */
              for (length = tinf_read_bits(d, 3, 3); length; --length) {
                lengths[num++] = 0;
              }
              break;
            case 18:
              /* repeat code length 0 for 11-138 times (read 7 bits) */
              for (length = tinf_read_bits(d, 7, 11); length; --length) {
                lengths[num++] = 0;
              }
              break;
            default:
              /* values 0-15 represent the actual code lengths */
              lengths[num++] = sym;
              break;
          }
        }

        /* build dynamic trees */
        tinf_build_tree(lt, lengths, 0, hlit);
        tinf_build_tree(dt, lengths, hlit, hdist);
      };

      /* ----------------------------- *
       * -- block inflate functions -- *
       * ----------------------------- */

      /* given a stream and two trees, inflate a block of data */
      const tinf_inflate_block_data = (d, lt, dt) => {
        while (1) {
          let sym = tinf_decode_symbol(d, lt);

          /* check for end of block */
          if (sym === 256) {
            return TINF_OK;
          }

          if (sym < 256) {
            d.dest[d.destLen++] = sym;
          } else {
            let length, dist, offs;

            sym -= 257;

            /* possibly get more bits from length code */
            length = tinf_read_bits(d, length_bits[sym], length_base[sym]);

            dist = tinf_decode_symbol(d, dt);

            /* possibly get more bits from distance code */
            offs =
              d.destLen - tinf_read_bits(d, dist_bits[dist], dist_base[dist]);

            /* copy match */
            for (let i = offs; i < offs + length; ++i) {
              d.dest[d.destLen++] = d.dest[i];
            }
          }
        }
      };

      /* inflate an uncompressed block of data */
      const tinf_inflate_uncompressed_block = (d) => {
        let length, invlength;

        /* unread from bitbuffer */
        while (d.bitcount > 8) {
          d.i--;
          d.bitcount -= 8;
        }

        /* get length */
        length = d.s[d.i + 1];
        length = 256 * length + d.s[d.i];

        /* get one's complement of length */
        invlength = d.s[d.i + 3];
        invlength = 256 * invlength + d.s[d.i + 2];

        /* check length */
        if (length !== (~invlength & 0x0000ffff)) return TINF_DATA_ERROR;

        d.i += 4;

        /* copy block */
        for (let i = length; i; --i) d.dest[d.destLen++] = d.s[d.i++];

        /* make sure we start next block on a byte boundary */
        d.bitcount = 0;

        return TINF_OK;
      };

      /* -------------------- *
       * -- initialization -- *
       * -------------------- */

      /* build fixed huffman trees */
      tinf_build_fixed_trees(sltree, sdtree);

      /* build extra bits and base tables */
      tinf_build_bits_base(length_bits, length_base, 4, 3);
      tinf_build_bits_base(dist_bits, dist_base, 2, 1);

      /* fix a special case */
      length_bits[28] = 0;
      length_base[28] = 258;

      const d = new Data(source, dest);
      let bfinal, btype, res;

      do {
        /* read final block flag */
        bfinal = tinf_getbit(d);

        /* read block type (2 bits) */
        btype = tinf_read_bits(d, 2, 0);

        /* decompress block */
        switch (btype) {
          case 0:
            /* decompress uncompressed block */
            res = tinf_inflate_uncompressed_block(d);
            break;
          case 1:
            /* decompress block with fixed huffman trees */
            res = tinf_inflate_block_data(d, sltree, sdtree);
            break;
          case 2:
            /* decompress block with dynamic huffman trees */
            tinf_decode_trees(d, d.ltree, d.dtree);
            res = tinf_inflate_block_data(d, d.ltree, d.dtree);
            break;
          default:
            res = TINF_DATA_ERROR;
        }

        if (res !== TINF_OK) throw new Error("Data error");
      } while (!bfinal);

      if (d.destLen < d.dest.length) {
        if (typeof d.dest.slice === "function") return d.dest.slice(0, d.destLen);
        else return d.dest.subarray(0, d.destLen);
      }

      return d.dest;
    }
  }

  class WASMAudioDecoderWorker extends Worker__default["default"] {
    constructor(options, Decoder, EmscriptenWASM) {
      const webworkerSourceCode =
        "'use strict';" +
        // dependencies need to be manually resolved when stringifying this function
        `(${((_options, _Decoder, _WASMAudioDecoderCommon, _EmscriptenWASM) => {
        // We're in a Web Worker
        _Decoder.WASMAudioDecoderCommon = _WASMAudioDecoderCommon;
        _Decoder.EmscriptenWASM = _EmscriptenWASM;
        _Decoder.isWebWorker = true;

        const decoder = new _Decoder(_options);

        const detachBuffers = (buffer) =>
          Array.isArray(buffer)
            ? buffer.map((buffer) => new Uint8Array(buffer))
            : new Uint8Array(buffer);

        self.onmessage = ({ data: { id, command, data } }) => {
          switch (command) {
            case "ready":
              decoder.ready.then(() => {
                self.postMessage({
                  id,
                });
              });
              break;
            case "free":
              decoder.free();
              self.postMessage({
                id,
              });
              break;
            case "reset":
              decoder.reset().then(() => {
                self.postMessage({
                  id,
                });
              });
              break;
            case "decode":
            case "decodeFrame":
            case "decodeFrames":
              const { channelData, samplesDecoded, sampleRate } = decoder[
                command
              ](detachBuffers(data));

              self.postMessage(
                {
                  id,
                  channelData,
                  samplesDecoded,
                  sampleRate,
                },
                // The "transferList" parameter transfers ownership of channel data to main thread,
                // which avoids copying memory.
                channelData.map((channel) => channel.buffer)
              );
              break;
            default:
              this.console.error("Unknown command sent to worker: " + command);
          }
        };
      }).toString()})(${JSON.stringify(
        options
      )}, ${Decoder}, ${WASMAudioDecoderCommon}, ${EmscriptenWASM})`;

      const type = "text/javascript";
      let source;

      try {
        // browser
        source = URL.createObjectURL(new Blob([webworkerSourceCode], { type }));
      } catch {
        // nodejs
        source = `data:${type};base64,${Buffer.from(webworkerSourceCode).toString(
        "base64"
      )}`;
      }

      super(source);

      this._id = Number.MIN_SAFE_INTEGER;
      this._enqueuedOperations = new Map();

      this.onmessage = ({ data }) => {
        const { id, ...rest } = data;
        this._enqueuedOperations.get(id)(rest);
        this._enqueuedOperations.delete(id);
      };
    }

    async _postToDecoder(command, data) {
      return new Promise((resolve) => {
        this.postMessage({
          command,
          id: this._id,
          data,
        });

        this._enqueuedOperations.set(this._id++, resolve);
      });
    }

    get ready() {
      return this._postToDecoder("ready");
    }

    async free() {
      await this._postToDecoder("free").finally(() => {
        this.terminate();
      });
    }

    async reset() {
      await this._postToDecoder("reset");
    }
  }

  /* **************************************************
   * This file is auto-generated during the build process.
   * Any edits to this file will be overwritten.
   ****************************************************/

  class EmscriptenWASM {
  constructor(WASMAudioDecoderCommon) {
  var Module = Module;

  function ready() {}

  Module = {};

  function abort(what) {
   throw what;
  }

  for (var base64ReverseLookup = new Uint8Array(123), i = 25; i >= 0; --i) {
   base64ReverseLookup[48 + i] = 52 + i;
   base64ReverseLookup[65 + i] = i;
   base64ReverseLookup[97 + i] = 26 + i;
  }

  base64ReverseLookup[43] = 62;

  base64ReverseLookup[47] = 63;

  Module["wasm"] = WASMAudioDecoderCommon.inflateYencString(`Æç7¶¿ÿ¡¡Ýé	!rsNïYs~µÌR»¹¼R´¾R©7Sô×æVÏÔÓ6ÓP[êL1;\`tpeÕ»¶Û®¯«_,1Z>¹¶GZr¶ê 6Q[0Ý² ¡ Ü]Å_²«Nû((wtÈë´¤!¥çÈ#¤¿ùé[Ó~Tó%ó5ß&£Kç Wã lÿøõoyâv¹Ewå;uuóÁÖúÕÙ"MtïÝ´FUw§ËìQ=@¥üH7Å=MÖVÎt°¾ºûÀ	¥¿dÙ|£Ëe|²eßÆÑó½ù&(W%'¹T¨éz~ùÉÕ½ÎOsT×NýôÏû¼þÅÇÎûrý¢d][eÉÉvÕsÒò"ÕwÎßQÓÑ0×ÞàÚßÓÿ×ÞÙ¹y=@óYQs|Nó¤]¢ï¥©¹ýx]O)[W§Û¡l|ON)sÎcÉ6T¼ßÎ\\ )Ô¤srµßñ-¯luAmÜíoùÔÓ§ÏÒ¤æ A¨@TwdKGczgHüºÕ~¸~¢Õr$C?ò}ç\`øoÒhcÒÓ¦|Uâ;ï¨9SñØÞÜÄ,¬øÕ÷ùÕõùäÕù¤ÕùùýCiwA&£_ ÝÚÄ0iãÄÝÕXiåÄÝ­ÕkieÞÄHÝíÕieäÄHÏñ16¢cóýþMHÈCy\`kÉ>_·*ê¼ÑRÑ«Ô@ßQa°·Õk5¿»á¸ÎÇOqTDiøüM¿þùÔqTÿSËÓ|q÷q_øò=}Øü#|å@T¶~ø½ÕKÕ?6²=@Ê~®ÎyãwL²û2ÿ«0Â3ÞÝ:TçÏº ¨ÄP_b£ÆãÏKj\\R6¶´I¼l¿zd¤|Gçk½oý5=@pÕA9jXªÙÒ?I¡ª; ûË¨øÌ74^üËp_×"bSäí¬±/ëMGjVGê^Gä>7ÅCÈW6ùÀõÔ."ÏG*tÚ¤mß]¦Ìj¿0ÊGªu1_HRnwk×2¡^9ç°þwDgâÄQyè<Yûf®<óJÎu\`m\`Y9açp)TÑ×^bõï%9%oÕùU9OÔÎ\\ZfV~d& (gÓ{Ë	£Ñ¶R¨_u}ìñ)Í1éÍôÖÇrPü³³ÕÌÉ>	Cv^=}=}³0ò¾>id¹·ÝNl¿?ØÃÕ7ZûÀ>aTÑðC¥Æ)ãÊqöx¡Aè>¿8	d÷¯çßú)Ìájö"ÂÁ áÀ·HI£º:ð´!#¯ÄÒ=@Üä	~D÷Ý.UïØ¨=JæÎï%aU§gß_pËèY8¥·oøÀR£-RïHÙ×<±'ôé&ÏÉÿÂïpÉ¿5ö,QÑÁÜ07µJkäÈa%ï)Á®ÀßZ¤ÿZºQ»N>!YYï/ZÎÚü×©SßxÕ~à|6Ôgià0_jÎUAøþCô^/ÍÒIGíU±dÄ<´Ô<{=JI¶xe©vàä@Üs­g=}ÓçÆw²(Ç83ï x?3V¼Côä°{ädiÆ\`=}ofób¤F=Jpvý{Ú=@]ú®\\Ëå¾·Åpß¥Ä¢\`egDÕç#=@[£Ó"=@×øcßøðì¢ehÕßZ¨OÕEÖ=}¦g,GûGÜÓÕz	Yvµ¡v1äìþëÝ¶m§g¶ÓÓ»Dyí~~à¯-¯Ñl1¶Æòäu¥çÃ³!-mÑrùüj·Ï²a6Ê=MË¥Ì-Çew]Û«a®Ò×Z=@Åz÷ïa´N@*Ã=J=M=M¸tó>üu2D¤·Ày/x µè^òEe_£.e^º7Âf±Öõ=J«=@=M£¿eiÀM¦ñÎbùx!Î¿íÖÔd²ï"õ´Ø.éÛ¦)iÍ=@y}Ë=@PÔ9n~ÝhàW©ço-Eö¸KÖB·é§°íð=ME·d÷\\iLY=}ìÔU£Ñaó&¡Ø$&y5O:=JÖ?¿	êÿAô=@kÚÐËÒËòe\`KÃðéÓ¯.½ÿ=JÎ)'©Q{±´êÂÂýäÖø°=@7»fn£Ö+ÙAã¾ë<ðd9´	ëÖmÈ8ØÿÌ¥ÿRÌ0-Rs¬câ#ùTD]-¢½kMÛE[_3èrÄ^ÉrxØD*PMp£'s?¹¬¼.6;:W «döîl=@m\\ävÇ¶ÔoµÌ_þÇt­£!vÆtØdÃÎÀC.RsJòKÛè(>ÚÂç½6>G¼ÒMkq*Ö9ÈHt_=}w¬Á^r=@ÖÄæ?':ÕLÞ¸=M=Mj$;ü&*ìRð¸÷<7ÃÕÁ>#{78//³pk?ïáÂÛÌ$Þµ%¼ªú´¿¼©{Ã±ävTE×UjfÖ´À\`õr=}MðìmÂÆ:ñu=J$e!.I.Ûî¢AÜêË¿ZlGL0Ø*éc¦+LSK7Ò®^D}ÃF»¹Ø¯pwÆ,L4ïýÌÜÝ¢h=@&vÞÀ3¢Ë¬%%=}ðßA¤<nå'ýUÑYkÜÒ´ÏFÕ<ãÔd¬ðbJísq:®S.Ó¥º[6¾Û+âôk}Ü\`}5»¨ìÆk=MïÜNº.rÊ.PmÚ!>æ¶:öoiÁ_~ÅVNÊæjÀ+­"\`ÕxñCp½maC>Zzã9iÖÚÁþÙÖ²³ÞÔHD­U­ÖÏ Oµ°pÛO^Xò]Ý¹ÜÓh¦­pÃ_ÝöHQ8v¡ºÝÝ6»q!«Üè.ÌT;ñk»ödeßnçMÒFÞÕÅ¬ïó­»§±ãúæË@@.ÜïðKà¯þÀý:ðÀÞ½S@xY¯ÉáQ¢¥íÙP^=J³|qÞ¾ßûàÌªj¾·jôp:#¼Q\`ÒÏKÆÄC2äZxbòdàGH¸Qø¦.ÇøL0)6¼}ÅsoaP[ñN´¬,ùµÏÌÃTßÖmåí,Æþ2tÈZ°·:ºá´Oû?@ÊÑºX23½÷¾y]+?¶ÇWàwÂ½W(ÂZÛ¼MÍ¥PIÅö6 \`/ÛòFTÉ=}W±AÕ«ª<äÍ'tS[cÌUË¨ôBÐÔÇ_ãCfI§Qþ	§±i¢ÊDä¨F =@ÇùEOrb)c­TFÕ_4àæÁîÔ-à1¤\`[~è¨Vö¨p\`yõ28*Þç¿h~2Tr×a¨MÉ%¿¤Þ^!7óëÞ 'dc<^§6:¡ãZ!à¤ç:à°ãE5r6êÀ¹zÁ|¢Y¾áK2DócVL"¯!Ý ð~ê\`<9;]E¤C^÷Dp	#ÌÿÓAìü¬¸5ëlJù\`5h½]öÎt(ph©­ð¢aö"÷×aÈ1æ£t³òìîÞ~/¼t}RZ³@°=}ñ~vÕëÀ¬ÜäáBGäc·¿9vB´nmn­0zM?Õ=MÜÏTBÍëU÷P^«ãæ5$qZÙmþJdÔÐÿ©¯]÷ðv	-f­æøô>6]°]a¹ÂBCgÓ¥ ÖùT¿¾EUÒØªÂq)¿h-èwÓRänWühßãB¤0¿h^Û¸ÐÒKt8Dè²öÛ0ê=@gÕ_ª±Ðç·¤¹°3d^â9KGýC]|1Ë=@¥.bP»¡ý8lÔÆ7Ó	-^TÎ£-êÔytAó¶ÜF©íð·ô¡uKåa,>w¡ÀÌ4±Ò´MûÔ}¬G'ê_Ð	îÖQAt7ß¦\\ÞÉôÐÞñ6½4ºQmYvÕÂ"Ê¼O¾Ö<åo¼TÄG¢.ú§²pTKËCÒÑzl6ìþUoçtê$²5@æ@D,µS°6Ó²ùïÍ$]3èl[?;æ·þOÐ¯²PÀ>ß?ß×¤à.èX7Ê#sV±´¿5½¼6\`þ0WwiÞ)Tâ¥­8=}ë*dÜ@¡´T%ÑºÎrX5Ñø¼t 0*õæ]àËÿægRÝrb­¶{ñÁk=M<&qfaC@/ÞDUqü.z¿¾Ú®þº¤°KÜ.uÇ³¥_ô¶éÞwø|1z,àXó\\ã{6cCvÙ­àÙ\\óAìHåZ0¤v½ò¨-³8d7Ï=}ç§riéõ'ei"A¿ß©)ý	'3&ÙÑÁÀ¶(ë%c5äùÔ+w²û@ÊËàç×àÃU¿Túªÿ\\¸\`¾¯&íN×u|¸Ý=M´ÙUþQãÜ~¦à~=@ÖDeo])RªÄ¤%)þi -TÑãCÌkriÌzàÈÕ%õdÖag{²ÌÒwÞG^K¶ÉÇ6[ù0øyHÞå^Ýð÷õR×e{£3_ÙSs,¶¤=@C~@loz5Ó3ú¤µ³Þ=M.y¤|°Î»õ\\.É5=@7.¯ÎüdÖÈç°§wEÆÅ^P°­¨_§-\`ÔÍw¨Ìâ!¨ÚÒó8_SáM­=@oìUFVüUX8Ò±nÛ{mz5=}Ñ¶¤ÛÏqIÕO0PË¹¾¸µÙ°SPtÂ¿r9K§è\`Ó=}ìþD¾+àxqfÑi}ÊÚTÕØ5ÛOÊ(xWÐw­n¡Ôe×·¿ÀÂt?¶»èF½¾Þ¡ÇJå=}iÏAlá3µ©ýPöVxµ5zAÙz<û¤´©åëláêIô6í¾9;:¤ïÄ0àÉË¯mmý4ËÚ[&£=}lN)Ð #¾¢ö¾\\¤<¿ÑHf[úJï=@UõÎü¥Æ%aÙTÏ{þ!¥Ý1ìÇÊ0',oL7$~bÀÉÓzE±¡téµhìFÄwóO\`èwdçêidÅïÑ_Gæ¦ö=@Þ'¿<fmLÓ5Ê·Ü¡ªdüÆ!Æ±ÆÈ¿÷s¸!;÷»Þ$Ø%gÔ+ðQ¥¥«£pðâòN·[Ñ[Ö®òÐ7´)ØLK²Ð¢m Ir«Ç¿ßMO÷ssç¨à¿$KÑZÂ±+£T_>\`Fó²'ÌÏ&?Öýá: ]båÿ÷¤¼÷¤gÿú(>÷k/§!PßaÜ_ä&äNá7AÙ¯ó%Qlmgsã¨yÖñ^Ø'ñUµÆÛlþ{ùåäÞ°Q¥ü:ÀeiÃÀw8àøæ_´	£WÅ=JcÙB¶WÖL÷ÄüÁuFe³8¬KÓAqÏÒAå&Zî¢çÒwy1;ÔSsþÛ¤-OÖÐiÇXè÷£­tVd­³¤|ÕÿZ«¾ö7u¯ÑWYLHwÅÃ³ö¤æÒÙ×ÐÍø'3_¹í#=@¢ÚÀWðÿc=}D*ýt	Ä8WäëÀæâ¸d ÅS%u^eÃ7=}gé#²=@[°Æ©½!)3ÄýÉß´9©FÞÏÞ»Ëp0¿|iã#åö67ÜÙmO|çn=}YÙÐr#zIòCÂÙÝBÍi$ý¤ñÕ]tyÕöÿ¨ ©/n#d gXº[wUÎWpÜØ¬<Ú1Bäáp«à7Ý}&¶?ª¥é«°ìÖxæ!è_àÄ¨-:xæ÷ =J-·OW57íPhBWDpµüòÚþeZvUt\`Á¤»Å»Ù	î@b§»ûý@¸±ïeR°hÌ¾»N·¬¢ÐÿqûfüÔÂ>ÝpnB[£gÞX\\\`ÐÙ­ÆÖªË¢Økz$4ãikÏÃ\`	ÜÏ$k7#=@^Aw	Åý«,Z3µäÿ²¹))HþÇEýoTHV(Ù­àìvûd3?¥MCq´CúÇ%ðà%RÕR=@$÷¹ËuïÑµ98÷K-Éë¤h{Ù=J¸¼,ïÉrmycÔ?í~À$-"X~£_''Ê¸~z©ì·,§ññÚyà¤¿îë=Mw®ÌÉ?pÎZ¶dckh÷ð¦ÿ!ºD?óð®ÃJÓò[.¹yÂ\`}îN¼^pBVÊGQ&"È¸	bþaØ6Px>× QoJÆzËÿTÌN¯eR¨N	pÚ¥ønòÃ½pì®ý[Ôâ·º<#\\óà&äY?Æ[ã"½¨òµÎñJ8Pê2a®¡1ýòZÄ'¦lM\\ì9ÄÛcp$]C¨h´W×#~=@v+½}³sç"CoÞåüþ·Z×-»óê¶¬*Ö»±ÌtËÍ=@·)5z «tÂñ[@îÏÒÜ¨â*Gë\`dÞ3ÿÊ+­KÃ¶ÙG6-äÖàý=MÐÌ\${íê=};ËóHÀ´¨ý|Ê·aãSEz8­nïªÎ5TÅV,rÑ!sçl	©bUÜóó¹³@=}OQ·Ç¬õKÙ®mhmöÑú*uí²)0½¸b=@Å±þÞ:xÓÍ>:³Û|ÂÉæ¡_oRÚI(dì<ÎÌXeÚ¹\`üªü{}©5l­'÷å=M<_©@FÙ	ä¹Í=@a,p¦É!vìîÂ_OàD=@øÑ/'Êòÿè1º^ho9ÍnàevJë¸@DÞHþ4=}lA8p&%í ²<x·)ó3wy Ü]ÏBJÓ. Ú»e¹±]ÁGÝuS¬g¼yÛD/ëTçª·¨B-)zL´A^zÎGn»t Á\\ 8üm'ôna9¬a=} Ó¹I¦"±Rè[úk¯Ãq }J~4njÏ&SzånPÕÞ!3ÄëuÄA»|j4¦À/ë7¯r´_$zçdñd}­xÜzÏ\\1³õÜ^yWãÎÍ UBcÚHöÇä9Ý-ÅjØ$GbAA5ïì?]®^µóÏ½Âo½W²KßË;=MY8íºa(ÅÈv^Iý_Vì(BT( ÌÈX[Ò$´ÿ¦£g	Ó¥½yÝµ@=J9=@´IéP S=}¤ûæÌ+ãóx#¿J\`÷,®e#wÍò¡¡ëvZ¾ó§¸©Ù\\òÁC!´­ýÉÞëåv­gðãy¼À QSVR|ÛÍsêùJþR=M«[àÈÙ>©´wéÁ[%×«z /1MöÄ¥ñ@ÁQ=@´@já"u31G=}8:\`Àwlvº@ÆkÒÝä=@Y­oßÄq«êo>¿=@Ã×8yOô=@=}s°CCµ³N¼WdçRï¶·wþLmAVÛCð%Ä·9_e&hãNjæIÅ¡4qeCdr/=J66ÞõÇLc¿÷Ñì=MGà=}?Zcb°MRÃ	kÛ¢âmÅðê­=@S42À=}wN1x>ä£o?5e?LMËA´8j¸KÜ¿WWËEËW§í¬j=@²WÌîeÓ!ßÚÊnïB:n¡Ê	Lï(®Òm¢¢=}jË¨È4ú«HªiË [âá7Þ£3·æóGcs¶þ¹6Äh&ªùáÃ=}àÊ[]\\÷|ÅìOã®e¦2=}UNÙýUª(Âä=@iAäY8x;é	3!úH=@_%bù8zç¦1-°Ä¨hÑGGAö]´°nE]@EæJ|uÆóÄá3\`±°¦\`¢X©nÇÈÐ±wPÔ=ML8:¾ODTK¥£¹lTM^4Þ¬J¼¾TÁå¨èoÿ_OüD¦ODÿT;À¨<=@5íawxí\\0çîeMàLëäïÒ,:r9NDEH-síK{ï;,>ªRç§}ÆõN÷WmæÎdÇ;ÿ°GÌÉêëþGìâ§fæî7or9öZõ3®mt©uÌÇû°3êpÛ¨·ÅiFøÚuZúÌÎº4·=@"j¥ÂÔú*n;¿ö*öÃ¥ãFÅ,LµÍ{Ñ}ày]Û[^i(Êõ°Qöðo÷?øei³Y@iZÈÔÎ(÷ÀÐÝuºr¥é¦Y	VçÿX´8Z³­Du«j®KYÊÆûÁÜ4ÃnJ?üx{ÒUïÄÛ;ã¹ íDuz!ë »i=M·Ì^ÌøÖS7XCµDU¡^Zðhª=}ì>ÇE5ýråhÎ·ò¡ï¥=@sÂú^þ¦ÓQZÂÎ²E¼F^Û=MUàÎðä0Zn)Ë¯b«¯Ã_7?af6ïI¤òigÊ Ó_ÊvqµùÔ÷QÁ<V7npÀÀæî¾IIª×µxW!älØÎÞ¤DÈãK[(@AºZÔØrhä­q¡ûþdîNÉèÒI=JkÑ¸NÛRê5?´i}»9Er»-ó±ÂsÊ9µäói ¡T;a¼¼ªß=JÍL;"¦¥Þ\`¿}b¥²¯$3êæÍ©¬³'¹)ÂrN6Ûðçrß|Ü~ØNjÜ?³]y=}zûÕ¦]úàu@ß}0b9lêæÓ¼ùò4î0Ù±rï+þãvK7ÀKÀvM±ëé(UY¯8´hÙºs-LígöâT·äsWb¥7ÖB!M5Ã.EòGqá"áEÓüböî>OmþT­æ¿Åå:^êö[ÔrcüÖe, »xÓ[fãþ+ñÙÁï¬è´AVíâÊ½sgÙzÎY=@Ab°'~á¬AòÖê¨4¶4m>ÌsÌ-·­,µ¢Å)aeÛ·©&4âÐT×­k&]\\gPXcc´$wY\`¤cúøYp¤Tð%º¸|ÁsÇünóÜRë¿P!Õ%!oGÿ9ÖDiØäbWËß3¸£oYXjwï7dx¼ÏZ=J!mXê^¿¡ógÅïªØ+$;>|<±Ë5}¯qtÍ@g³}à*%Í<¨àZ¡hHÆ~}ýÉB»n"X!cÎ*»§zXØE#åì¤$­Òçeó(å³A]±bªÌ,\`pÐÐ;ñ¸Êï¢?a;ø^k E÷°#ªzxI÷ û6eÈÊÊ0fg¤[d\`Nf9ÄC|mK§A²îäám<ëJö7¡p©p,ÈO3M§û#¼m=Mÿ:ýg×1HjäÄüä8vw³ÌÂÁí¸üºÏ1G^l5@uóR'Ûã½·G[_ø¿è\`j¹X¼duô®'óuz8o8*P8©UËí5CB½÷+õÆ²¢0Ó^±L·b^t2:;uëqE½ë"1uWh{hff¾¹åE¹Ã×Û¡{§=M=Mýq=}Vä{Ý£·2Âm/s_öõScBW½µij÷ \\f ¦ÆÀG \`EûQ¥Pvyà}i±Vý[Ùíl É8­döqÂø8úõHüLeÔma¥±Û;GÔ8·{GdÎ=Md~Ü½;AiËðiCàãÙN±Çö?±çZ48±Âj8qWþoOQÆ5Éþ²*ÇÝsf@Jö=J¢3HBÁçþ=Mô~¹ëIµ­¹»7\`øÝqaÈgùÐ¥¿ý¨¥"ôØÈgÜ;©Þ"7&¿=J$ðÝÍ(ÖË9|iáIDèÜ*Ù«·1ÆÞ]--JÉR¤úe]#Ñø;#¾éù¥Íè1±ùä(è·!7Éß&(·%±ùzØCäØ\`¦Ð73ù£@ö«Á¶B§<¹ÝÓ[©öô§¢6!ÑÄÆlbæR¹ÛÐ¹ñLù¬ê¸.òå£a^XQÙå>õlêEÚ:'¤-JêËCS¬í9©?xr¡ú²Æ\`ßmµKÉ=@I0[aYÛP-àèstµy'&XÁÀýâO=}Ö{ujè ¨bµ Û¬Q¢D¬é¡yskdìfe¶º¯ôÐ^¢F[Þ­Þ¢\\¢æ´ôOçí»øqÃ?HV{N=J\`Û¿óÛM©§CÔï|\\ìÖÒ¥k]æÝ!uøYÆwéìyÎSFðl·	ÜåµLVjZþi\`]¸=M6î×H^âß"=M9U|Ãã{|ï×W;KÏj+mäè=@ Nr5ôH·ýv+±ZX'¼à±ÆÂhNNnÃ¤êGdrqÏ®+JðA÷U[À;³[Æh4-;HI¬1M,p{ô¶åë¯éîëéá=}®F!8Ø(4¯éG´Ãß½|	%îÏumÖX¯åüÒÞ.}ÓU\`²ÍJ¿CÍË: z$ÿöA>d#>Ù§þVè=MÖB	|¼ÕË=JKÜ³Wn1:A	\`çmcíô}§ÖhñS8ÖÙ=MbØäÖÐk¯ì¨1]ÓX°Ü0ÛÕ½ÔìPÍª ô;\`0H}fWk£hØ"¡{{kNÚ¾TjCµÌÖmµ®ì°~Ø¾zKCÝîoßuW*5ìÏS"oÚ=J¹ý@Þ]×Önß-<¨ðT¢òa¶ÆimÆsÍÐK½hT7ý ,FÀû.®ÙºááÂ´8]Pcv¡úõú¬çX±X¦ÉíÂn3[v±0ÖÈm7ùK¯ÿu¿/Õ!%ÚD±Óe½Ú=}ïY5±íK:²í{]ºÒ®ùÆr³úm M#Ä¯Y@·:Zì°¶k´-o0Cc:ÙFS8>Éo8ÆöQò¦¢Á[É"Vmúã6QøÛKítjíÝ¥\`È]ìÌ¡6³V$Ø·¡¿VD1ù9ÁûQ#ÔôÍ&ÔÁ	\`ÖUÜ¿·ä³ùL¥È¢\`a¦@¢@Ïoç"];Â"vïÉ¼é¬$"#Ý4êÈ'=JC21¶Â×ÔXþ71ÆqI²fÄ8	ìÍ9ÈrB¡A¡61Î$RÃßûè_´.Ð²t%°öäá[gGûÃ\\7ÞcÔ}?IòæJ]/ræ/6æ»·|pHïÖ=@ÒôZéjî=MþHäáJù|µ²6cçæóYßaí#ùíúø¼C÷±úF\`2ÛÖôåú¦Õêv	Ø¡Í|ÃÿÞ{«7Ø¾Ål®~·ó¤LÌQæ:gÿü^¨nµÜ·Êºv¢ðà<N=@4Nr\\À[(xY]h2]A_øî@w­(úúÂ¤uÔhBåE¸iY!cØÖO°ó2©ù®I_õÅ²CnfâÖS#>È%Yêí.òß5ï¹÷§Âa¸¨mR^ùïº?ï°íÄCÖÐ ¼C¬Rÿsoæ_H#´ò¥?"Ô2¥þ³&xÒ½gôç)+=}r|ýu¥ÂßÎÏ]äY'\`KökLGg5ý?ZLn_ôþ!¤gÅûäþôò^ì®.î<½jÚkðUÃÉ¯^5ò¬áhïrËÝÿVI¡À{mêê½ÍöBæK­¼LÐ¡Þ1b:ôÈÔòi!7Ò§æ±³YWáÃoçâ(ëÄ§k¾´¹ün®=JúÐùS°¦âðoú µ´zçË~¸ÔéjVkR¤sÜ¶\\¢ã»CÝuËz~I2µ'Fz0Y4loGnÎÐ­55vãØã7¬Q	Ë­³w	¡±×'ÙEêÇj¢R»aâ{Ó{;- Æ'Nh=}gmyÖËö4ÔÇh+Ä¡,}S%Ï¾=@)ÜÁÏ°6jùæXìÈ_£§â©osÒPáK½£qó}JW·Rü­V¡2ÝH||º­ÍÍ0áÿÊÖch+=}(úëèNu÷§O*ä%m5õÊìäC*(qû!3!NíÒc?qU!Û±gçtaX*Ï­OÿP{ï%7D}¯¶ýÖLIå{áLAÛgF6.è½LÆîÞå=}ÆØ~§GÈ´Ü5}JÁà×k½G~\`¾ðñÊHÛiÛ02­¡¹ß"å8fñ{=J××Ä0y=Já®Ì¨|·ÀSíâ$ÄLökÀñ³æà+ú/G­=@'¬ëãXÅºyûRàÜo2=}F¤õ5úõ ÅhmT¨KxìO:ö¬ËØõ¡e+~Ê}Üì¬&Çá×Dxî}ÇÀåÍAKI[¿GTá±ÆÔ'ÙQ$'éªÓÃ]§÷½.°x¼0|vy­ù¾G,såH4ÛÈÌÔ%ù3Áù¾ð½EÁcoV:ûM[¬J~B}æN<«ÿYw©u{üsºÏtFW=Jnª\`¦{Sm>Kn<_¶ßî«MHVØ:XYzüÆ^ÛÂ1å¡ÜÆpV_ÅÊ=@=Mbè¥SIÁ¶Ü\\XÃ¨Ýhýd©,Ã}¯ãÒyþvÕÇÆCZï+Rà.p[µm$Â ì>h³PÈïßIS¤üß'Ëåë)¦&¥&+kî)ó+ó!À¿QÜ¥C®ÛeÄzjÀ´l6¢²ÁËíçô|¬&¥[ðnßÕRF\\,J¶C Ë²àÒYº34)4ê=@m:dÄj Y3÷«¶fÈºèeÝÂ¶ZKepvËJ6Ø)4·ßq*:vú°%JVíúÎá÷«pH¨R£±=@°åÌSZO4ÒÛKúö¦fð[E{"=J:ô­®ÂxÙ¢G^~Å¡¹7$äKÞ êIÑ_´N=@Ë{Ó] Tø>$¤Næo\`áÊ(æ}Ír]4>é*.ÅtKô¯pZ5Âxíg¢ÌÖ<cuDw÷¼¿ÂFLª@ìb.@NÂ"R÷¯oû¥îyî7I=@åP&óK¯ØP>×Sáûj®S¡IL¦¦WÀx@ðjòMã»h6ÄäC:ºb<¢³àS¢«r(à2g=}yEWçD7p^Iîzü¤=}t"»×MèûBøá\`å4G0¬,¾Rìkýå¹Åðh ÙI&)(î(ig 9¤¿ý~2Ô´Öt"¡Üù¬Y²ìÁùÔ?°>i:c2é $q>Xét¸3!hØó=}¢"hP|Î¦WÙRD{ÐùjÊ'Ü}Ô®Ò]JÐdixóY@ûGROSÆòÁÏ6HÀ{õ·\`,V³öÆÎ~ÄÜf?}1ßôª@úOK®?u\\9/£Vá.Lk§àgÛ®@¤ÿsyöl>Ê®ýºUÐ{_SP:=M©ÔA?ºqt5\`¬Ð.A«IV	´\\îlo,jÙ@ßVv z&	t¦âl>V3@µîÄW|gïGÞ"É®~Éy=@üÀÖ§ùÞhîeTï!cá¨BÖôèð¹jÖ¦)Y<'Øx*'©%áQ±ÑxÄ^¿7©Ê ÛlJ¥6})Ã7u}Ý.M¸ºôþ» -lÉ\\wâ5­³÷·Õlp*cv7ÿÎHÚä¦ÙP$s³Ò¡îóD/ËvYôØSLR´ô\\/©/68ÌÚ<Ê?öªª¬8²@ÉÞ5@«>o~ÔNQá*ü{ÆÏäp<2LH3Õê<Î7Gnq\\9fSBNe0¿Ü¶Ä(6õ5{èôÊ*éä+DÇTÃ~ßE@>DW¥|ÀÒ ?Ñ´Oc-nKP¦ð\`VrÒ=MÙ°wÕ_ï=Mçxþ}áæªº·ÁÃSNß\\<ÿ¥JÞûB©VB y:³øQ^tRzóÏ¬Ù	ìÇµ	"ÿ_;kä|&YÀäøFâÙ)Y)_ø¬â ¿Ã»ÇÇÂÒ%=MùÚ#Î­Ôt¡ ß|ÃühÔ¤¦h³.o\\f½³ÕáÓÔLÑ:¥yäþR¡²~=J2VÐ6^åfxÏþE=}ÎH·|Ä?ªÕÒàº±|&çáÐcKX±Wa¬l:µÛ$×¦ôð,Ê{ÈüËÚ»S)®þÐy×q©ðÒöWÁêFó1ZQÃXV=}ÁÍÎzÄ*Odûã&]Å¥Ê,2þ7~ü­÷º<Xrjd¥-XHKñ+õðÙîKÈdÍÞ9¡°?/ÒÀ£ÁÑgJÇ2§£··ÔñAWÍö#C\`B<oÓm+|éÑhðwj¹-·<ãV¦ÞÕM­0HÕ£­Mý½ÀHUH¶'M]Ú=@(ÄÏZÁ]×[9J°"+ë(.ûêÈVÄ*<Ý®¤ë<èBLTR£=@>hKtËNÓÚ^Á²ÂºÝÀoy¼Ë³/·,ös<!¿üî"döþÜÂOï%)ãsN³Ç"Ù\`[Ú³jkLJ±hbM*@{j~g=}ðÌ¿Wp{13*M¹} jâ.®<kHpÕY±Yí)øsp$N@j¨Ó>L»»,"¤÷ÂÉ,(/·dþìýks¿4¦z\\åJ7¼[ù¾PúVg¾ ÚÀeGÏs?ó???)|K=}ÀøÊßxòð£2?;Úî]4<ÃÛVÇoéJ.B4Ë¼Ë»YOOm3±¸u¬Ò²®^sºüÆÓ^J~o=Jq³PâæÃ Äì4å²A5[ÈåF1Á»déûÙ¨ÿu[²jÅD=}òH8¡¤LeÞ²>|O	SQ£kL=MæpÂg± áÊ­#S\\4¤êÝ´»qcÜ|Óª¶-PI|ì|àXöðW NöpèQ»Uñx)áFyý%®<¶\\6bl2gHà>ÍôZÄoÎp³J²ÎÓqO§p\`[õ:ÔÃÆmZi9´>Ò±»|ÆWén½¨X@tu°ÿµÞ3wwâïE$àï¿þ²¬¬ÊñW}ö{aÑv³¶%¢ö·BûcuíÐ¡ü » 3Ôh~íÎf·LÊ~ú\\ÙcñôCÊ"0ôÖëÊ]Hð+ãøs®»î´æ2Ð7î³°À\\Ì0±÷ïKVlìI±a·_|¢6â_þp#É¿U|¶ÉÅñì| ÙV:G.±«Ày1%=@ðÈÃÊàð#4ú|tayÓÌ+àójÎ;[NøYèÏ(õ#ãX"¼ºÄ6?M£MG~sò1.¬AíbÌ[ùþ^.Ì0¸ÛÇ3QcPæÞ1E~7Å2¹ÍJfÿÖÛc¥rÍöH¬^Z,Ó¾Ôý=@Á~Ï*[ÖfQÁ´Õ¸ÕÄ\\Î6I\`ü±ÕÚ;qîa^M606¿»M¥tÒíÜza_Þ§5g{õö{L2NG=@¼,*¹jºE²m$ÌdL_mtqâæ[µaëðëîOL f·¿òÄi_\\ÀöùT!µ¨B|ÏpÖ|A»àÀ2âÏ¼¼ôðOÆ¶> Ñ±­"qÙ=@eMA­gëqÉÒirKúÒr3ºÎÅk®mq)ý{¤kEùkJàòzòªÿÇ FjÒgT%¢ûY¨µD8*D Òl¨øÝÞ£ÜA÷Éßeæª°­ly v=@Á¾U)ÝØåÈÌÆIÈë aÉýË¿gÙmW%ÅÈ4¯Âi66B»ù\\L©Mf¡M¦XÆå;Èbì	6A®Aì#EÝi«§X¥XfÅÛØ¦ K¦@lkc·BKüLÆÐ¾PAÀms n¹£ÏÂ"8×$òËÑ<ËMNqoÖ!1À,Ñö¬æyÀPYW"U'©B=M¶ßÐÀt´éÉHÔNi¡¡¥qÝåüúàÌÍØèìÂ7ÿZKæî#VO3á%nGnìû+Ëà%ñOsÜëgõ±¥é"E(¸UL:º,¿ÒÍësS#	S>¦»wô;BÙÀÉÄÔ|úâªvËMqåèaÈÁÄ=J,~Cvi}t3x¤tgñ8'¦ªÆàJYäÈUu²1Ë×,Js1ÝäË1¶ÚW\`G¨ÚXuE\\Gú®ã:Ëìµ-ü*8Þ7UÃ,Ù1Ìª"ÏÂÎi×ñ+¦@Üs«3óZï°geV´ÿXC/¦9ó®½¾´ôRhnÓðön&Ì3y{VµUíHSô3íÐ¤¶Òõv«f3æêâ*@àSÛ}Netx®	³èÒXz%¯û©ê	(7´ARÂ_ó#ªË¡!æÌ¯vF5-Ð­tô<ÁmÏÂÜ·þ÷;Ý@K»-ëª-4F¥}5çö§Zj¥/»ø¶yÝeÚe×õ¶{æ¼ïe{^øJÔû¹\\ÿu'ú½èJbü¢/	<$ïuÈúY=@¦10ßF$.*W	Ì@¾LJ·W=Môf h}3ñUß73½7ªá7ÃýìZªøv4J÷§YêíÓ&Ýl9içÚË|¢,HGÇÇ±bè7Oæ!Ý§ÐÃ%AjC?Pä&èiûEù+É¶©TQ6s!/K?uÀÒ#Ï¨]i©M¥\`h@r»#m9ãJ-G@Û&ÈV,{¶V¶­¶.Ârür¬tâ1C^¬¤ñRþÏ2=M2²Å±G'{nµ=M¦¹nIPBªtÚMü¶xùAFÚâÆqk+\`ñ(Ü³òw×3ô?ëpcþl÷s´×|;»LFÆÀíÀ-18bÈ6=M5ÑïÊ÷âB±ïj[8µ+uãBêÑô£7ÆÛ>*/¼w±.Ô(l¢XVèÆiõïÚºeÁÂ©/ûS"<õ´¬°ú7f²/74$E×"0É­Bè{Ø_M°=@½æWÚq5¶k¡HL\\§Ã/à£Úí%5EÂvèã·Ê<óÎ4J@ZS!¿CD%Âûÿ[»oZä@qÛs6;"É<	­úÊnñÚÉá·½Å ÖäqÛ=M¨ý2·À»Üi)ìÐ/Ò[÷[-I±M5ô&Dÿ{$FÔ.ØûÜ5È¯p:«ê¹TåÂ½h Ð=@ÕhÏÅ¼©¥åÍxÖÓW=MÝíæ÷ÊRMj|Éiu=M7rtcäæ\`õK	%ÃrÑãÕR2Hà§4ëù?i+#ù!XozPW?Ùþüô±qImÜZ"e?aÒ¦ºíx ÜªóÇv¼h¥ÍÕ®~°¶=MJárn-³§ý£!Ò­ì®³:°¬ñÙÞsÀÉÞ¾=@t	M±Ësv&û=MsÛCUGýWò5Ë¸X«Â}vÍN@ñÞyañ9pÉ ²qçP´To0\`¤} c»Hø}NnmeòÈUN§Ãzh¦-l¶IÚüñ=@à9¾äæ¨Îr¥Sáö¾)úÐl8üB³½w¿gÃ÷u2ÔbD¢ÒrÆª©´îÉ¢øèêÛS¬¬aèr¡KÃ;U=JH¹@KÉ@tÙh#=@qºÑÎÉïe©Äq@×"ÀÉu\\®-ë½\\´¶("J=}Òi®ìHÙ(.É)Î­ P¢UâpÇ0	H£ËOïI( Û:hoÐ½ù=Mv	=M¶¨æ=MÜ,w´ù¤|3#SÖKÛÃ)Ê+T¹_kôÌÇSýH{î¦ÜèÆ¯¤¤3o§}	_Äwuîq 2O©H~¼W9Á¶tvE	/¡ZACCBaU£<]eS#$.§ÁØÁS¬ìéPÊÜò#ÉîÒkÑÕ«aÏ*Bþñ úvÈóñúT3x@¨Ò±¬¡®þö& ¤(·:u¾Êta)2õ!Ã*$¼ÃKÙæln%¬·÷st#®¤"¢2Ü7àMmô@ãÙTQâ^¯(ÜË l%ñéÓÉµCxù±heV4í^	²rÍÞ/!24ó­ Îé¥RH.XU*ñ>|º=MÕÏÏ{³¼P4\`ö#çôÁÚC_,Ð¼(]´Çí: JÉ÷oJ¨ÖªÌpì)¥_Â=J»¸{h;§òØíý¿¦Õ©ßCsg?ÕYàÿ\`°mF¿Xÿ0oPü£×n´¡¸²EuÀ´ïaÁ{«tÈK\`ü¯=}-aQ-ªçÀÿ	ï¢OÀ\\ÆYa{Õ¯1 »;á3²¼'q´dà uíïT3zaÐnûnUoÀnMüKJ?9|vÏæÉÛ{>ÏÚGMùFò< ý8Ïý ªt¿d0Ëã¸ýh$pc^ñs$fÙkmÓØ÷+B Ò*ÓèZ«wèú¡xä°KZ¶Ý÷+3À»OöÒ7îÓvÌ"ÐõkFºcÒiOô«ûøTÖ¿r×"õnÞWMNtè®¶\\(¤Çg±ÆG­ì º·M¹×Sn¾ð¦*Ô­TÑf\`mù17<ÏOMWö0]|kqìö´N²a½à\\Un×=MÀ»o+²g{ÑphUìÒG%F)$»ÌóFÝõzHßØ~©"Ð3,QðwH³Ð¨S¦¼ù|â±=@q=@I.+°)+{Ð=Mö¹uS»Ö!dÉn2³SW»½èèâÒ¶õl$)V5Þär>taË'*8C$ØcÜ¤ÂªÞÈ;Ì}³±0¢2[ÜgP'wãIYko*±+s\` 5u¢!ÞGák¢ËK7Úö,¦èþbòcÃó;x\\ç¥^Fû ØõG«ýÑuÊðÊJfd-iG:=}§W÷8ÝóuÅká9wv®M'¾Ýù"6g2nâ*rÔ¤=M}í¾v'qþÌùtÁ¦v úJ~ç@À",3[Î¶ýÌsxXÃÊ7Hð?+úkS0Ckë'ªÜ<aá²Ï.I;=JËí8&¼FÜ&¤Õ¦m'´þ_1ÍEà¿awÅ9Mâjþ9=}£Åô5K6SÃ=M¢ºÄIÁ¢äHQé®\\Ù×4jLTC^õmæ¿e$jÓb	 Ìtª½4¹ºKm3Vubp=}	ùÙ¯ü9hÇÑu'¨­æ¦çZßÌÏ.xEºg(_¤éÈ¹8÷¦àÛì|MéUÄOTÜsßÚxw´/[VÂ	í+üêºh Dý éò¾öhTÈLwOÁ°OCjc¥¯Èy\`ºÕ!]ðÖ«¿£úr3[íb8ºIfðýÌz3ÁkÚõ-I8Þ~¢b"ÝÊëò%(ó~0ôw	ELE.ÃÔ56Kzòsbñâ~²¼Cýnrì]yÓ¿8VÙg®=@RÙ³V> 9 eÊJ\\%ô:ãÏxþ<\`X#7_e¼ãkÎü¾Ë¶§o7ç«\\ _inAÏ'xðÝèHvâ\\¼ä-©³4÷ Ea^ºcoR­)ÖøråÌR&F5föÓÀÿKhSá+MóãM¶ {+ï*2p[«1M_77L3H®êªùøåuÂÑpJH±2ÄK=}Ñ	hoFáE¾âmõ!ÍË®ËòÇúTqKMvuî;»/s6Ï¡±ôn.NÛEÈxÀ\`ÒæDæöª:,ÖY=M1jDëély@Kçb~WËOÙäVÛ6U'jN·có¦.V±>©ÑÁ.IÅ¬½v/F§¿ÌÀæbÏ¦ý\\.Äqÿ2#ÁEÜ: 9\\êhU'+Bm%~ÎºYÀRZMõ 1Ü©\\¼[è0'ªÅú¿Î{Óê=}u¤ÀÀQBÕN¿à&T§wI¥æ=}CóêëkAQÝk¥?ò¸ð{IsÚTV%W÷²l_'õñþÒ,F~Fúnþ#e?\\1oÐN)âJñcC6NNòÂV;ã_^ÚòÆÌîì®._7ÙÀÆ3æPïù,7¯ïÀ:y=}a¾>NÓ!÷*¡-{÷ ¹Õòú§åúí¢*~ÛhªÅn^²pf"ÄqQ_HsìèøVWâ7írôçOÚÇk82ÌÞkÈWÜ\`a}Nª¶9G,±ùrÐèÈuGæU&xî;cÎ¥TM>ËÍÌmD£­÷±4&Ú¢ÄÊ¾º,*Ý¢bg'²þôºÑ&0GÒ×±VCi>Ð§>¯5<Rw!=Jv¢»\\æH¼ 1Àssÿ;fpç[½IeKéìÅÐ¢[ÆÔ^LÜúôÙ¢	´%!å@ÈóÚnçÚ#àù,Ê{Þ¨#ßÜ=}m.Áð~Ç/fì9úOjØìÜ\`2ØkslQöCwnéý¶­-­å«ËýnÚWá»»ë¦CøZ6ABJwkkÚy)·ÂÀIÌ;c£ã"^ãªúA1OàßúhyÆþ&¦no¦õgC$?Úy÷÷]ÍåÐ^ 3rá=@Zá"Ûd - '*dÖ	ôã=}ÝÛeZ$cVüµMè/tUJQÂ&=M²km/Å¦m£µñ"ÑôÇmky5~®VQHaËhB´Ñ7ë£ùLÍÝ^ãí!~B©ÖÒ´1ñìhÃ_m#6Qf'p¨rf6è^¹e=J7³ÀxXÁö;sKQB×«=@Mºf¨§>Ôí »nV¹õþîNý´2ÚUg=M-\\d¬À=MAârSPß<â¾¦]Ö"k8øgH uñ¿Fnº²ìgu#Ð.&Ú\\²rW#® 3C3=@Õ©{¯©pÆ{L:B+i¬_ ÕfÆw;ÆL+8!íC{ÇÍøytÿkÿ¢Æ;z<H±5[|ÁÒrX=Jùó ý7QÆAå^¼½¨ãÛ¹ÚÆ©mÐ'giõçx¨v{æ óo7zÍ:u¬¾#:Z¥çPkqxÝU±£L=@a:ëç1òT>Ïòg¤Î$'}uAW,ÃÞ¬H9X÷Þ¼pLªr«b¦\\"fG(2¾@0_4e¾ºÀ!µ01/q0?ÍKvRm,YÝ×ØÖÊ	éÀyä¼N]^h´N<ÃQµC¹þyE=JúÌG5Q¿´I\\IdÅm²Ú0¥´²v0{±%f3°Æ1»1*}#Ì<[ø±MQ{Gõî3öP­ ³LÇJmµ³=MsRH¾S<ÚiÆk.(a²´æR¥à #nðZ×¹rÅEgæ.ynÍCwKJLÀé7I3?FQÆv6ßFþîÀ¤/§¬.óBÑè!K]ÁÞù½|r¨ü! ú¬@¥5é=@½yiU6ü4«3~Ç4±-mm¶Éö¶ûð±¢2:íÑ»l÷U|¢Õ?÷J¢ÎsÒÓîüý²bx[ExgL­@2dÎôõÒëjbPëÑ<¨Aöi¦ì].Ý·Î\`1ËI1ÏkãÆ=}rj¿Ò,@6ýô^Ï¦TÅß¤Ñe|ÁjYnu:£k9ácLÜI»ÍÊè\\Di(£xßÝäÄ+»­-eüÆÏâ=@±;¯Ã$Uk@=@Áz¬%1zÙ°IVØ	ÖÆÐú'K]X{Å·°#Ñò+vÍèrÇåì­Dú'\\(ÞÐ}z(óF^ËHÎÕ9·}åR=@à;®~å7aË[Pé«¬F©õ[Hæý9=JÇä¬¼$áÇ«ÝÜÞïµÄ¿påÖQãH=MÏiMIçøÅâVúÈÿ¢Ðü8èTRî0Û×­âÙ¹OÁ3¯Êå5$Ì'=}ëâ>Ó^Ö»âÉtµÄ55àÚ©#²ûzbê®Ó3ögò¦ÎªûQHþAzc­ûE&=M9Q[§t¹ïãÜ¬µeÛÖí¹ÖÀw0Ç_¢õnRáá<H!@ÅSïmã¡ÚGÔ6Ô¨º¯¯¡ÌNÀ@BâF×ö&Sdý-=MÝjÖ#´ÙýS×mÀèÚÕù0¬@h=MÂøÙ\`¨##qiàMÉ=}sï#8û¢×¹Æ¾ß1dqÞé(6xùTMß§B°Ù7¢7·=JÍ=@À÷+|áa¶ý±ªðX\`É\\ý-Ëôh°[{.cô¦îY¿0ÐdE´1WM²ï$³æCLR;At^ÞÉwg	#\\ÄÑ §"]éîÞLb>Û½å#duZ}iØ¬áwvõÅËè¹XýÅ5æcÀ!ð6»ÕEñ×>ÀIs±jÿRE\\§?6<V©ëVêlA!KÃ¥ÄOM³:_¸óoêmÇÀ©§blÕ|#=JÆå>ÜoIóÀïîÚ}|Dl!nz,Ï÷z ¯å¤y=M7\\ãÚ§Lù=}$\`fæ¥M¬hÉ¯SÔQ»¬´¿½·©=}ûÙW%Íè³ZÛr\\ÞóÔ ÀÙö©/6¦Ò½½X(Zÿ¢íiF]#G¥µ>¦MéÝöKÒ|³}µÏ¹ä}0M ²EýY3¼ÐFÃ?U×=Jà(¬eããÍ_Åé¦±R&¼Ý²	Dl ¥)ÊmbÏ_fñü'&¡¦CÉ=M=M¯é­eã:ÀÖôùhé.©=} !â&Å	®dù\`ò¬\\0óÉöN£îÝaÏíkJ|Þ©óOÙs²RAÊfpÚ3õõÅ"ÒÌlÅçá(Os×ö#»W¾§tøè9t?Óùwöp3¡¶·É1=@aL/\\?\` ?msõêdyÞSQIyqé//â&Y3ËißÓ#Ç6È£{ÏÝ ZxA®ãòÅóH;:àYZÁ3¦jòöÉ¶OHKIcF­ÍçKßETÔëF7gÏIÆ4¡;ýøù}¤^f«1ó¶ïÔÆ©ÜfxþVã4ê\\YáHDèæ	r/±´­EbF­+±Dµk¤¿ZÃSàè<È¡.ªgúGÌÞHF¾XÝ>zÿO¼åcoºQ¯_í\`íÚSÏ=}èZ¹ív§3¢ºì°dHû¼/^û¹°qfzo×÷o¾sc¹)q>¹#Üº2®1=Jl3ìF.wÞå+í#:(tßhÚ§!$¢pwÔð!ìSõ©-ïþ·ÕãûÄ·cºù&±~!W*øò¥=J¼C<kZÉ¥W1ãq&¬6½÷YÒ<'¬üóÚÀ_NQ>õ¯ßÌÊï{¬iÖ0æ²ª'øèßýt«}ìÙ¼:ÿeä=}EX@¿*°{¦yxÈzÏ2\\à:Õ´v:ï¨7ï­,Ü?¤uÚÑÖH°ß¬érOhBoÐÊKµ¶§«©¿êu[(?zo¤®ßTÛÊÛ8µ'ØLARd[ EC%M å Lpuµ'=@¼´¤¡·gO òé}é#}a+çálDW Ý:¡71¾-Ýc åÛ	H±AÂVª0,Wl&±E2Ed)æt:¨Ýi¼¹¬¬ZÍxÖIO:µ²÷X·¸KÓØ±ÔfÔgñ:¥¢õKuºkVÊvjuÊ×@g3Ý úaûØ?a)ìÒ"¦áþ ZKùâ·C×#ãìÅÏ=}?éÖ¾\\ òÌ0×yrX+,È6=}î*ÀVê¤¹ìhªJ%é@ÿþ,Ä·| ¨hM68bå±çÞp±]®ìÖ/»o=MpÆê¤n,xNI«=}>Ærh4Q<¬éhª²=}Dí3·: Â$í¤{#*&\\ è}ö%éçíÌräèCüZzjn¬BZ@¯X1øc/[-TjDxÐuÆýÄøc'x­'%!¥i	ç¸ïv¡fÑþ³SÞ=@µRÞÅ­ÒUæ­5¶Hkß)Äµ­\\ÖIA	nÝì®Ç²å2QÂl¹¿.aÚ{|-oÍfvú.ºr/jê\\}ªY[Çì+by=MÞFÊ!2_üZ,ûY|+ù.L¶R£Fûãð7wi¨><H(.¾þ¶>ÛÊÈÓ#»¿Ïg¡µó"9ÛLó Ð/Ìeîþ%ª\`ª6n¡°Öê\\<JQ&Ã²§rô<£¨3ÊöÂÚ°¬V<ÌÌ%>-C!QsËd²ê8Ì\\Â*¿--ß?²¬2R|:îÅ=@L½ùjÊCÍëÛs=}5V2oË8qOã/¬ ±	d\\@Gó?HÅVÞ;)ayà½GÖ.8â_ôàRv¯k5÷»EpNÚ<;è_S;l½Ë\`Ûsî©<Æm[lPléºï»µ¢rho"[bbJñ:\\W?UêR[ïýÐÌÐZð¡m.Ë¼8fF6ÌL¶âó[ý1?_ËpêåÝp0BÓëlÊ29A¬½xèX®52A_=Jw×0½X¯íKÔËËÌtºgÍâuHÒê5=@ö¸_GHé2ûNcµ-çº«jkóÃmÙõ¸%y xî+¡O¤2ÄÖQ>êf Í#Q?lòÃ0û´ÁvBÍ0_5V\`$6,Ùéë=@½(LE®P +D¼K¯R»¾ðt4Ìmá".Söº¥²,ÖCÓ4RõÿÆ^Z%ûL=J¹AÚÓºÒ(D¯TK¡[YÜBèÑYÝbïhJE§(ÛÞøX·{Ö;yãªÍ»bîtO^Çu½ðÂï¿ÐJ|Ê9v¢<Wd1Neúæ*þã)&GÒpË6qúáùj·70Íw\\BßsnÎ:Y@Øm3áWì«ªXl´4Wé:Ùv²Ðÿ'´;Àèñ7tDãa=MñW*VJ®xðË^ÑF8£Äbm}í=}1¥÷4ÞÈö×^cfy¨£^Ô¥ÚNNäg¨<óÄJªÍ(MÎ:Ó%»3jÊ·JÛî+oRî-êúÌÊ	Ìê¨ºó³ê}$wäî½E¾!ÒâKÊbD&Åõ½?eRü§{=JyAiÎ?È°RqÀ>õ­FU5Ámî¶NI¯nÚ¼ö<]3Lô0dqD¶ë_rTò0âS&w3<ÿQäèÊ÷Ñx2f¹ëµâpÐküzËõ9<Cl3­ò»_&-òOíÌ1.^4S³ïSºe;}Óp§°7Z­E4¹@l>¨Þ2TKzúMa2º&3YSS:kGÜÚ9évl­mb#AË÷G¬¯. ¡ù¶j³;m8=J;1buÛ6ÞN/Ì²NT,8OKO!BzdìË?oB=JaÈ=J=J÷L¬x±Ë-Óú"B«S­Z>¿0ôÀÊS ;£ñªdÁ©'ñ-a;ÏñBvÍZr ÉBdv¼W%T¹ð?]ìÆz9Ç[²]ôo&Ã+7|bj«~>ï«hýVYX{Êh»1tU´²\\cë&â0:Ã@6ÉRê¥ÄR^¥¤Aý.N¥&m²¹jxâ* «¬«hD¡	97sÑñÿiüÑé­\`Á®»Ú"ýÞS<á©Ã% Ën9Ñ	$%]%'ãQ 3çhíØh }WïÂhcbùn$ÿâMÓ=MÙLtrâ[-fK( Ìi:¬°_,Ï¯XAl¢&5p^G2q3cáïO¸Rä6°jÀ£@ã1=}9ò¡GîM-D5k}×2I~Ðz°¿~!_!k-èkVìÏº7£>ôo.ÔìßÈ]V;W®µBÆGÆò=MK xujæ¢¬@¼ý^0pKÎ5^mz4r¯L|Jl[IP{q<SìÌ0N^Í»ù2r0C÷Z1¥szQQ8DEÞ÷'îÛý7ËÊR¼Ðã©º»D±~.ÊxþsQ4{Õ=JÌÚ¨ÊÏt±1á¦Ú_üïNÃB]6¹»JÜ/·MÄËÈ=@^1'Ä­Z]:-Ê¯Ä~§r_tÝÂlUîG´ËYàV>õQÆÚ«ú¬Ñb|®Ksb4ãÿî;gjõUãúLïdcñ²QMýÎék#{F»µbËkËl1¬º=MÚe½qÇåúAërï:ì.0M/sc»cÂõ^¬R÷h3Þ\`,uD£*#Ñ7/¯õ-^ªÐo},K_.¢=},¬:µºÕÐì±4µfµå²yÕ¥Ò;A«ÉîÌ­°¢k#L¨MÇÂ¯õu¢Ú=}s,[©ºû?8Ç#ËH?JÈìæ­ê?JòO©Î7t]=M6¦¬è\`[ÿ©j<ß5Þå;N'é ªÄ×N31®.ä\`^ÃonêT>,ïKëªçD¿ÂÚ´µÃòÈ+;/¿¨Ã¯	;î£_&7Âoî¥D×Z7Ï~ÆßÝ X¥æUaú¿ªÜf£}+Æ´Ïµª¦>/yÍ²åë£)|2ÃJN·©]õ%Ïo+¿,ï}3Ûî*³ë®f²2[ÊGÓ¨z.9=JDy]ZÏºÆû	xLÅ²=My&ç*È°è3>À;¬>×iÖÞð4@.b¢±¯C'yÉw³@qó/è·ò# ²¸D{·Î£½¬á:wq9r!NÅò^ÄE=M÷÷=}¸Zoîc±ÃÎàxÉ uÊK¡.n÷@9µª^¹Ìn·b\`Õà­¾Öïê?%t1|¨õ#¯"_é»º7d-1·à±Ìã úZ»O÷ÆUÂ}2éû8ºë=}HBrÎ;±(å|Ldnf-[ÿÈ;îÓ;"oñ¥ÔôhåT;îwÙ4ZøØ4h(µâBî°áb:TeÖû:E³¨w¶%¾ù3VjMÓefüÆêó¤Ú%6ÌùrÝÀ¶O¨±ßìud£ÌÉXÚÏ-³²vËwS¦±µÔ.¤ºbZ[q8	®å^|5ÜkåsøFÅäM::ÆÎ¬ãËq°©-o°ýØçð6ÿxÒ5=}±bß*OYvöÍz¿ÎìGÉK'L	¹SêTvóO[-"á[Ï²ÂãñÆxScøfî=JûEãf0.î=J*8$=JBcÜÑ±Me|ÑÑàmOC¿åÌ©rÂ÷_âàV5ÌÎ¬ç§Â&H+k/]·b²=MNKÂ¼s9´0a^Ú¡É~sf¶eMJØpÎP¥ÆL¹1ÄÅ­ÇL=@åFèGpm@æR÷Ñðêý¨pþ%î35òc&zàÖ¤N"º1Hê¼zé6òXwmjLaÀ±%¯¸*ûDé¸¢¾j0¨48b1î+	2Ýãdc1i¸U uk¨%	î+¹QÕBkV)=}=MqòÏ®9ç0,,YÔ«è©þ*6)¥7ÐBuRCS}º7³¾öv#Tý÷@¦T¢Ëÿâ×ón¹Ó:òjqT:Z|ò³Â­³æÙÒî5:c¨ÄVxdjbAþyÌ©ì8TU*Ôº¹ßð!Í=M´âÏÅ¢/ýZBV5ë^©ÙÄ/x,0¸Rø¨ödÆ|Ì,ñ«Ýj*û,2J4pæÍ#k®+\`í°0Ñ_òµÒÎÊ\`Z²t-·Ék¬?lö:]=}mÂ;ÒlvÙ²ø­ÛN7èß»1Á=}¾¿é¨.OµàXMâ*0WRÕÀAoR@Oúnd%ëìÝ£Ø=JÖ\`@/¡ÜÕ±Á«UxÆþÓpF%Ú[«\`²ÚÏdEn=@/_R8i0v0Í tÜ­4×£G·|«{<BâU­ë_íKÊ»2 xëÚÞ$±ºõFÇx^=MQ¬Ö5wëFÏªB6:t{R$]\`SöÊm|>ñß?x*úÅ|^ëé~s6uÔ<Æi%q¿îÖjºÇr¿(Ò<¯ÍÓCã·?·'Iß|»)á÷Óï&iÔëä×mv Á@O_Fîj­óÓ£ÏKXz(EJ5äUÈ(ÍÍBWVãJÄéÎ´Ï{ó{«JÅ@^¬i÷ðvC;ZÄÀdD-fñôSL¢Y;¬cuÞ¸¸JYý.*z=}Ådp"¾?VÏ3ØÁêmñÚÚ-¨ã¹ÖØuÀÅÂÎ­û¾ ~ëîxâXú	kxòPÜÕNoûP?~F³¶Þ=JÌ>­	À*\`Vä+mÒ jª5KÎÏ¢Jþy¬ÈS°[SUûAÃåDo:5ùÓ=}0Ûy*[¯\\:c2õZjj|/IõHÓwµ»¶kEMZd¨Zs¦KJ¾.$Ár­öMF?®=}l²àïD«íÈm·o:tUwJÀ8(=J²+6Fè:Àki;ºJe=@h2}ú%j-´¯}¼;ú? $³±þ³¶kf;Á=@ñO#< &3Ô:-XXkÇ'$S¶2r-÷ÊÛèZÚ$unæ3Áýìº4î³à+z+Î1utÿ\`DA¾&<4[2à0Ö¬@ Bdo:Ýî;Û\\³åÇ=}út!Ö¥5?NßRåºÕyÄÒ¬ùpÜyz¨ô_ÙóîUþÆQ5û.:ôî2rq¸ÍjFì­?Ú©[2}.U¬é:Xúÿq<²²6jöDú¾}D¾Ñ*ç=}¢=M'øEÂðôH*}®]-´È­ú_ÜjÑ}=}d5Ëc4dÆý^&>?m77'#®¡Â§g-'@c®ë@BìØ×_tåC@æ5.qÀÆpû«·@¤×{:/·LÞ¬ïÃÚ$ÌsPHK¤¸bAÎsw ÖìHkÞÓM5¶NXWÃ»»%b÷eeý³UxÈÜU:<V\\îîÏíÚ·èQC¬¯¥Èõ3½2Ï/dûÎÌPþSW¯ú{Äqv_.ã\`1·LpDï*Ú1%ô/ÄÔ«:×4x>R:(hrjpì;Ì+« ¤GF°´ÁK}ªÔ>kë.!D¸{R2>r0=JÊH;Ñ=}QÊ8Óè³btÌ:~ íÑ,{ðÚ+lýòü¹0Ô¹­ï­NäóÐ§¯ÅD^HÇmKMñf½³+ã<{.Ý³,®ÆËÿ.PÑâÁ©µÖPJíb»7'=}ó(ò±úo¾-[dAz"y#Þ¦b=MY:ÉKôIrÌiÒ%yFßí¹imfkô«CL£íiûÜkm,º©øp<8ê^¬CùR8cËiK)Æ÷uõ=@­(êÆÉÜÿÜËiO(cEL^|¸8QÉÝýÜk{<öÜ©øÀõ=@¬(ê¢ÉÜ?úÜ_Ëi;)Æ7X^Rq-$-Ó©ô@6lAcúÉD#MÜ½¸aâ%a5åkÐdìÓ«îMZes5éDawq7&¹ÒKði°Bì)¶B2)]²K&ùK°iÍ¯Bì)¶@_(eÞê	Êoî©±@¿)eÞR)Iûl*5¾5.&	/@ë}@gº9ºóµE¬­-=}Fû£ncXdYFÒ±.o+2¬jºb~fù³$M­·À+»W)K­ÇÀëI]bC([­ÍÀëI]bC¦([­µÀK)iÊºø.<)¼k¹P2o¤ëJ¸([ª:Ä-R)Oå@S{E\`»ËiÊ2.²)Âëxõz#I]ºH,è©ö=JÒú,(å6x°<)ÂëoõzI]í@YZ×7Â(ní©9ý=J;²*Pi8}îòLV&:ÑpQOÞÚ0ò.ìrn0/øÐp3Y4hêðæóRe<Ã5\\u:Jù®)¢ç:;<SJÊ>2Ö.Dy&KøÉ2HVl=M«\\ý^|ò7bS¼L{þpál¶®z ûØÝÃ^vþp8¶úá²Z8eõQws"Q;d}\`*F4û¤¥¬ud×Jf¥ø_XëicpUñ§;íQ¥¸Ù;nôØ1Ø-Z2XýáZ¿löA{õ²®ÕùALï±DrÜ'6®D.9?ÕÒë«p}Qoßcí»¯ ÿºïE²?;²¢-{ [ûL¯ú÷JËÔ6ÿ§{3´ðkm;#U@ÆØi2³f2LKôü=}ü²ArêUzW;':,x2¾ÊMïÄÇ®b­Ðÿ×Æ#çÙK*2ûæbî?KÏ(9#îOoÉ¹=}Û»T±ÕKRéËwï{Û±Ð=@dM!£kB´3Ñ+*//ÛRêÚâË1¸!ï×=J¦d"Ú±êâ1î6tÀñi¨(Y'Q#ª58îÜßnêÙÉÝ8Ã´Ç/°û¯I1>ôlØ§ªp:À3>m~=JB=JÊh,½N\`&lÚêÏ>h2ú^FÖw'Ë=}ÁøY¯ÐØìfsTebXæ»Ð;ï]KÑ+ÓK{lSø¬wrY=M«Gö=})­õ69¬ª"c²ñvx<B½fEÄ);¯½lilTj>Vu{]b8¬Þ0¸ :dDüO$OþèÄ=@5[%cÊn;=Jy.íÐI©L®Z·3¬ÁÃ_/'´¿ë41¢½[KDc!ËÂ^©²ØZÞ%=@y	1,¯>*0¸SØ;0%ÿMæ&ª4ÊMÉâO.Þ«%Jnä;õùl1õ|HhZ®/å xAÒ3ßBÎìÙÌiJ¬ 4¢Àý«þD²ðò¹²1kä¿@sàÆoÀ=}è=JCòOë²SJë.ºp=JL½§¶ E+^á«=JYã¼5të¸ ÿú[;ôwõfêÃÐ0ìéLÀ.2ËÔVrjêI»¨5jF9³=}ã=}ë*ê1ÈPÜF>»o~BÞÑÖÐ	ge2¦Òxü×[s©:7e½uwúrtE=JÞ}m«BÞJíÖåMj	 m·XBÃ'9xå Bü5aÅºþM±í¸×+5fTübp¶ÕZC<æ ,·¬í¸¥~Uâ¤=JÚ½aKG,,òzrE?òK.+} aàWw^jH®î*w7Æ]QàD-¯Ù=J2:&2cNt!ò ,Î³6SrZ#ÈÜö?ÚYäò7º@Kµ}m$3¡Ë]®O-¼ê0ìµ¶¹È;´L¾R:ÿÇ6a2uóÁ,sütèrØ§Èæ­=J%JÀW¦ÉpA¾Æp.ó<&KKK©²äbN¹èr1}Y[YÛ ·KVHcó¨¼'=M ´ñÈiH¥i %B 9ÛCø¤©E¡Dby8.×Iâø¸áJßXjìi=@J3Uïüo;1¹0Å,·»µ=Jæct×i3s)mfsQõMÚ°^,ÆW}ê*¬¼:*5Ø.¸nþr*DÚÁÛÕócB0QNjÃüÿÉQ.^¡¬Ïö[dBë6:ïIVVÛû/1z-µb\\#ã9¬ãÈìëÀñ»Eèg?r[Æ1=JµÖö¿¹Æu¬Û*Òê*/èæ*=}"ªK=}èòCx´¢èKî&Í*tL:£êÊ²sJÍCZ×óeËÊZ$Áa¥NK·Fê=}SódU}Îâj;÷@=JL.Äiê¯R®lï#Úlõ´ª;§ú.Ù>?u8RÆd;x±bÍcÑx}øU«N®ÿªq«0f=M(-Ðk=JX¤@¶¤©­ßÏ³&«$Üb¼Y·å8kG×Æcu.}óvAÆS¸7sA/ÀEïï¥:|¸ºÑ,þÞWú|o N¯ç«öÐ2o¦oÛº[úkòê½ûÀxàG0ýgY]2«+%	2ûâFÏ²cÇ8ü¸Y:úÔþÀÖÖnVàBÜFtÂLÀ¼*ñÃ"ÙªJâ¯Êã¹}ÈlJke8,§:Hb2	(2×vx"2e'ÏàªÐUJú{¹vM6Õ_Ö1aVj!§«nÔ´Ò¡¼nHUu²¢JzËÏ7º¤ê¾¦",ÿAdÐë2.8©äí^÷»1ß1vÄj*RÞäýÖ1Äì¸«[öÙ¡K$rù¸@Oì¼W«H	,7Àuõ§Ôl­2¿å2d}ú¯´>k82_0¬Z¬ó3ÖÐG[$ÿ­?D=}Ò}klÊ1;*HPµ²MuõÞ\\ÿÚOÝ½~AÐ]Æº9½¨=}mÑ·ðqÖ¹LR¿Isq@\`UX§ömTIiý'¸M82åã®!s=Myùí=MbZç)ç{¸)Í{~\\rjªOÆó~Êp3¶=Mî=}¹]?fM3´]zµ=}nëÆ-¶QÂK½»:3Ü­ÍJâÚøûKZî<ßÌ3VJ^W7.­âÓÉÂ=}´¤¶Ëó¸Ür@ùÄ>8òª¢CFÞò(@"Æavæ3g'Æ¡óÜzéÆÁ¯¬Zæ:\`@òPn [0­G,02KÞE80°2£Î¯7K[oÓ@ºsé2=M9gäòÄHÇ²-Îîi_Ai8l1Yý¯=}+4êsÒ¨¦ÎÌÚn¯4rÑqJwË¥5/@r5¹ÇÄØÒsë >L¿&´ý¸p\`Cú>²÷ç¡ uî¬:A]òmyTÅÍ5øÒ:(!ä­zÂ#0#eÓG¬ÐË:{²jp<s¦cºçW¯Ôì¦º=@@Ãè²ÊÅJ0S5;$«0g;	\`gú¤Ú7ãJ«&¼¬x9àÏ0\\oìúv9àMQ\\NbîÏ'¥Wd78dp¾-0¤xSºÆ|=JÉjÏjQyX¯bz´mÚS¡S~Ø|Þltû4÷´½4"ãuûõSoU^Ñ>×z{42/DüLïRµ¥Ë«Ò»^8ÐH¸óÄzÉø¿Úa¸;«_ù(5Íå.Qüt=}Ôû®Ëô9øX÷ExÐ^SÊ©´fnbobþýwºz¾¯ònÒKÂ¸ªÛRöQ:Y ¤ÚQ¼ÖEL¤Úeü@t³âÂHkç®pHäw9 ÿLB­$ü,þÌFE4kÅ´e¾DÓÁ«|Yï¿\\¡S8S8ëãuëÄå>×úÆ|ÞlÁ.éëRïSBIëÏ¢m×ZS£îxShü·tË;ì@èÊè6V­VobnñªmÑ/aÒGÄ_(A/¤íbÌpa§>d)å{þüîAïÛêÁ:Ô=@Ô:{[¶	"&ç4{=M¹Tn·êÄ±ÔÊª]~/6¾(q~ÜØÆå²ÑK=Jâ[)Ê¸¹C­5Â{´=J´ ÊeexwXF[ÚÄá_ûÔ¬[1zÍÿ)Óyö4±ô Ë?¾á³ÚàÞåºL2c§ÿ!V´0UåÝmW}ûLdÖÚÞÝGV,¥Ü³®@Oæ5ì:¨éûáØq©b×Ë«>×Ë½XQ<57VátHg{¹Þun£-ÛStÅV=}Õ=}åNÓ2]b{-73§ëpöLb}¤êG;Ã¯R2×6÷·foB,4ÈJÆ÷$3ø½zj?(^ïÛj.v@ðPLVÙ?v:Þó©â6&1>Æ\\Ì@§/óká¯Íîïòc¥¬ªJuß«­-J®Àa[^ÜnZ=MvyqF¶¿@\\MGVcÀ¬Â4û¬;ÖGsí'qX·8K×VR=@±2ee÷ö:ê¯lÍkýmÕ&Jm³¸(¡Ë¶ïPPq;';ªâÛhî$x?$ÞÔ%J(èÐ?Ó÷Hª»¸;ZÑJ}-Æs9HU43k×45R6ÜHþv	ÞïPYVh¯è*H{RQäÃD;8é²Ê"LI.ì\`xâ:ôè,Ñ¯Ïú¹Âlz&a¡Jù:\\xÏZ+åÒªË{qÝV²$îÞ;ëö¶sé*m:>²ÚSéêj¢4HK#~:P¹\`(LÎ^ÑCV[J£¾®\`ëÂ@;çúlam}÷/[Ümû©·>»udÛ'}aÁ[Ó0ýòK×Ø(·Y·GÀö´ÞJ3î)<ÑKénÌ@².«ÂÝ7|ÿ,³6cË¯P)ËYvPèiÀ3ÒsKÚF0UÇr¶-wkxµRLPnô=@Ã¤ßä¹Ï)Ý_û4Ãø.²pTn®	¢á@Ö«Ä¼¨w9·æë§®ZRQí1JÎ,2Øá@o°@¼ÑYÜ:ñvâ&<´µDäjM|BhûÔkÔh¬¦=@ÀnÎmp2LXó9Õ.¼±Ê'¡öÁ0¨Ì¬Rjv NZ®%Vn:Jrjr4ìÏAÓÙÍFiü®¬²ÊØÛ}²¨ndê«n}þ®v¾L@}üV±ÍI\`ÓZìqöö¦R#[û=@f´Û»6Ü;äðW1Usª4?ú[ÊHHF.´a5}Q®±Ui«¬² þPÖS¯yGÞÑo;0O¬w7ÒM92G¨ñP°(®Sk6,µ·ÅtA%c°»*´¨âOÀ9ø±¢ªâ4Ð¡Rq¨û46C?·¥Bô=JÍßQl¥å\\øÿÈôÈ&¹Ê=@|ØßQLÑ?#°M>Ä°²U»bç)§^SÐÞê4­P1=}uwïs±V)ú\\¦ËýSIéF¬ýÁyÚ)=J,­EëûâB£°·ÀùUâê=JJ$>¶­IZgbæ[-#1$ù:­\\ó	6þ@<BZm8iû2ºRÈ´aì9ÚÂ}M¾óSÁI7³^m14TvEªl±Þ<Òmë=}OQSÊ=M;fvÐrÊmoZU;°2Q[AËV=@>âj®¯*8Þ®;Û9grv>éYÃ¦ý:X}mé=J¿pêIþX¬DúùÊh{²Ejtò¢&6xæ¬04ÄXâJSL¯=JlòÂA¶åZmä±ÚC´ïÐ1AA¸lÇô-Ï=}6J&ËÂËêêª´f³&¿RGhîm«4:P« ?Ìqpn/1z#:¯½[Io,µ{êf;¤²ÑN©;á³ì{²Ï2{æ²Ôï"2³¬!y/?À¾Øé³Á½5H·,H£=}Q\\MãZÏEýrV;0°z·Ð6,$:=}P7UZ@>µç\`=Jn¯}vH[;BX=@^}ÚI\`-P>Qî~4¿¬mîö .1M=J=J¬Äý2WÀàÂjDDPÐ-µ+î.Òâòagb©xÌ5Ûï_Ké¢¶SwQ:¦0FEn8Ò{¨«G²QÞÖºa1þÐw*ò´f3¬­àbn¬Ôh7L/nñº}*¦ó_/ø^/lLBPÆùÜQZ×ØH-X·üNºñ{¶S»^î.Èº4:*íÍÞje9ÌR°¶°®±àjl4|Ùû- $æûPUÄ´m2ã°P/nÀLâôµ X<o>Ð,ºÂ¡^µ=J*¤øD¸3,3¾5NyÖâoLIÚ{op=JÂ¸Ê~õÒÍAÐEcWÕw³û®x?£uK»ûÀÐü½Z7¼ôÎ*eÝÁmð/òèx.!ó·Î²B-s5,sÛ¢dæ¿ìK"q6u±ÅýâR¶ÿ}]ûm>U>{:YÑ5/@ðÅÒÍ:îaZRGZ?,5pæjÃzIæüj=M~qLê]Þ5jm43:ªõüÌd¶$ËÏòERÄ*/Ë8ªb¿phëèj>±ÂWòl+Ø}¯è¯ÞgûÜm*ÖWe(«klK¥/ûkn¬Yáñ4J÷F7|ÿ=}=@\`ÎGnº·í5Ga­sXh.y·L4§OâOKÐh;!Ù¾<¶ðÆ¢D©£ Z<Ë=MÊaBR"k5ÎÝ&.cÇ=}¬Ã*d åÙKÓØà/ñtÇhSúÁ½S_1Ù=}q$JJí×½J»2ÆÔ'=}f4 ü8F>,ëÞ5÷u m£P{{ÚøP9û²(9W^[4ì×6-p47ÃvnTÒn¥WcGGò«²Ê³EvrÑMÅ4M{Ú'¼zîÖÑýb·»î1±=Jòyù²Ö?yßÍ¤^þ¼leì³ÿTW|E9L²EL¾ÝKÁj¬DùÈ;ù_M¸'¢Øe]êØ¼çÞ¬nÔ×Ç×®§L«:.6ÚÿþÆsLxt§B4ë8@]ãR@ü1÷©¶7@vweX%NnKLîãÂZÿ+qd"µëÃÆ=@æpmoµ¦­ËYÌ {b3Çs/¸Ê²<0º/:ºð4²ü«âÁF=}²¿@°z¡ÑuªS=@¤wµ¼×ÞA«'F·¦òg¸ñÆ!:OJ%g\\%y¿}:×âÌN+³\`£nxùóÊ¿t®L¡ZN4OE7ücÊ=@K¨¯äf)Ù²öúrìjýANÖæîÚQÞ©i+çjÔxº»ÆëAÌM'çûLÌÁgLl-+=@ëö8³Ì%¬)¼OjYá[5¦¼=J²é_¬=@Äyõ]pprÎ®¯÷Z´ª,LÍ²¦=J*¸âUB¬º¹j×uÂFK?ÎA2bP#Õ°­S3ziléê~É:ú{b§>$/Ztð¯c«n©_1S\\xU@Lå:íZGûV¬81Þx·+Ç.'11Nè·ëPnòpb^Ý@ã8ÒÍçº¿Í=Jõ5	>D}HºÊ³¦i2D¡îÔoDB°¯fÎ²PcÿånWððÙ/cÊgµÐc	AØhûÐþ+QL^¢ü:|G_áAiêÖªZ4Þ³ïÖYFÌ-8ëÊ"tnCDqMÈb2Kbüp­^Æ²íÊnÜ}@9$X¥Ç&IGÍ7íÈdÊYð?S'Ín+*¹w\`k¢;¥\\"{¼pÇå^´sùs±÷p¾ÔÓ)çÇÚöü©ÂÌß9{Â>Lü¿µõHè*ö,ëFÇÙëp-¶\`4=@T³zs­òã·MÍµ{¼7ìBÓ_²¬T³Uü<ñ®/å0$7[¿®d 4) 4lÇU¥#)_¥£¶ÉÇ2Ê)SÙPÇP?nn¯+8ïÝ} I­ùn÷zxZÄ=MJAàU5/Z.xO1º\`=JJRê³rl+¦uCº¬¥o5Ô*o=}¯û,¼©=}j@¦Ê:=@8P¬=JQËúFÀ?³±®'wLNÛÂWÿ¹ýåqe3BÁ40PÀRÔrÒ^Zþj·ÉOÞõ;Ú®¬@jWDÜÙÌEÃÞì20xÞÅÚb÷«=}B9=@ë±£,ibQAE¾ÏºÆ=J9ÎXËXn­ó¼©gÙ(d/²àÝj{¯it×.²VX$ý¼;y ã/\`k¸m\`â¤ãhlGòøLUKåYä5?T[åx~¬µ,faOJÀÇOÉÈSå.î¡ÛÝJÔâ¼¬²*úÝý>ÂïÁ¹ /[Q§ëAº$		/ªdüVí_=JK3»h«º®6¯fVÝXÎ¥uFKRÜUwÚËÛ½º"1à¹ÞQ/w¯ïPÚj|ÄQMd¥»YdLÉ¹P)?t@dzîí4ÁëN3üþÊ_Ä4\`\\_KäÜ³A-ûý1où²B±\\UîA@ÿýQR4ËÚåþL?0E3À½]LªøË¥îBº0?Ï£¥ø 3¨@3ÂY£.1tyÛ×ÞýþíÞXsÀ½£=Jï}æe«ÞÊp5)Ü9[ðª÷÷ñ;3ìz):MÎ&N.6ë0µGoý¦l§ÏR?½¼$]¾3AÁüäFtyoÁì¯òÐfûûì;¬%ÒSânbcf¡»a>áÎfH7hSStOÎ=}£òñ°àÐz­vûÜ÷³5ù¨¿úb;©·8,­¥U³Äïk2û*r´üÌe=JÎ=MÐüÓ¾fW¸@.ÁMpMÏ'b¯Rþ<È-¸³ÚÂÂï1ÀnÁ²²[óEk*èÙÑFPRÆ'3dû=@¾48ÞWW	®£­3\\\\j>ß~fKK¿Oæn/kÉt¸AäjM¬Ô±\`ªn*ÊªoL{@iX°Hãxµþvõ[ðÇ&³¨h=M®¦6%«Å¢É2Ìä©ÅX{¨)fBkÊø=JE÷¬ÙëÔ+÷fG<û×´BIæ^ÀòÓ«mBK´ÅWÕï§KU\`^99}ïMÜÕ´Ï}JDÀrÜJ¼4Dg¡õO TäèÑéÏã¾ò¨X&m&¢´Gøw"qm&WÛøk¤¬r]HtOkøs§H8 u3¿Ð#PêP£ñÆñÀ­ñIw§Bis§BXX£Ú|²ÌöûCÃæJºE÷3=@RÑ?$zÄ:.lF0¢ùª9CDÖ>¶±ª.4:lµ	}tÎyD Ç9«×ËØã$ªØÎPíÐÌ<²Úo70w0XÇËB3êR<Sµ³c2D.æ6K, ]á®y7Ï½2ÁÐNñãº@«Phª0±_ßàæ8óÜ7®Ì9}A¼³ÃãB¶êÊ§i#xÇdGÏãÙäE ?ñ²ûµ÷bå£ÄyÂ¡kÀÊb-ì4Ml¬óMFV«[LìÍb»þ*k§Íû¯¬¿Kô=}=M«nVCñ|=JSS?ìõþ¼LnÝúØ?kz;jÓ@»PCÓ/d\`%-Ö½Üx¸®èC1õ%äëÿ2-÷´µ&W#»=}p:FsÞ×LL<94fþk¨T®MÍ¿,?³m'=}ÌØ"¨´K=}N#^FµQ/\`Ï0ã|iBzºße[<àN»50\`Îati=J&®¾_;nÎ[cRÜ¡U/P0=}Êþdã½å?öç E0{ÄTM\\TätYíÕµ.7»kå\\îÿKÁ=JmYs¸²@ýóÌtÆlÊlV@8LÃjyV=JÒzò	£WË+µg²óÇsô|[=}®²G?Ïú|EsÁrÅ7Öþ8Ý51ÐmÆ=Ms®Vy²TZÍÅ4½¤Çâ{ªÓJ\\grÃ[q}ço¬^W9²ýV07Ú-¥C·íÐ>ræ6Ä){û031ad5¹üzñ+¿}Ó¯~¯®,äºôm-ÀJQÇÊ)A~ÀUXë¦êdun=}{àTáÎ2áÎú_+¡s_½î[ZU9.££.Q­Ê"ÜK¾ª?M³¿sûv®j>V´Cw§û2:R!¶^ò@·Vv<Z8D7dðs®0zvRkÆvlº¶B*ýäåYÖRdñ¾¦s=@;Ä«°0nèNtL­ðÈ;ÝJPF´ÕN}kê4¬Sïûb;\`{$W|<Ë^©ìLã)Ì¡_=@Ø=JU¤!y¬8w6®Ý=};C(ñE¤:}C÷éû=@ì7dmD_Î+âQ¼X:KOÈZvÏbÜµ¶X³j:Ìh=J0=@"Òþ9M}ýU>>jÏS=MÑUîå;¥/Ò¥ªñãóÜÅG×©Îv®*E¿rorVÑ=M37K³'1óÒ¹"³ü¯Ôe¼E»vÀC8ñÔÎ\`Ox!ÙO]4vfµyrºÁs)U«Ðk0B:wd?0a®ë-wC±iº=@Å´ÞöM¹õÄ­ãßÕ­ç70qe½µVÃ¶\`à8Üë¨ô±!ß]Ï:sÜ-	ì0órfyÉÆOCèEèEéH¨ì"GûocÂ9ô0Oó¢Êé=MÙ UõªQ"sÞü©À¶,éEèC¶	èDé¦Û'&ï½Ç×í±I?±òw}=}´+Y:_ÌÊÒþZmÀ%¡Þ·Hw÷\\Ê×	é¦Ý' ÿÕÇA±ùhÃÊÓ«<v\` \`<F^uÀw¸ï\`bTÕÄXùTå§)T|fÍÿVeÓçþTáWÏ¨ÓÝÖÕçÎ¿9Ýòédb@|Þ@·g>£ÎÄ¾T·ó4»Tôüád°K_d¸±^bUzÈÂßÕÉ»h&hÕ28Ý=@7½ t©¦é÷ð=@P9Â."¡c¢=J7ð÷uôQtáÜX§÷ÜrN¥ÞùK¦}må¸±ÆÜõå 9Íd=@ÕV­U?l¤ÃßUÁÖ÷Ï:£ªÌûë Ñ (Â1OQó+Íh=@ÖÅ"îsÏ±Þt¤Moì©¤#z8NrÕè_x²½äÇ'ZÞæw¨)Ù°ñÙdÇZ¸ÅÜðE=M_ºboÙéG\\x¦ÎÆÖ~EtWùÜ_È¤S¢¡í¼9ÝÈ÷WY#æ÷V/¨9¢Ib=J|ê(ª+=M,ä/~36â~«/¬5ÉI)f)ö&EaiÛ¦¦Õ"³ô¥áæS£H¤_	=MÚ¥+!Ë1ä =J&ûÓÄýqqñ¤Ð3817 ´ZW\`¹·ëð °{Ú)Uè)Ä!ÍY=Mh)'¿¹Iàé©)ØåÎá%bæ ¤(ÕñYÕæÆ ôùÑi¥#ÞóýWy¦È¶¦&{ÁqI=@¥¢=Jk·11aâ©¹¥xèëeû¡fÒá18ã§'=@ì?ç(ëÅ58åÐÝ÷æaGDtaá ÁXJ¹=}ËÍ#þÎXWqÀU@JçäúÈ·õvHÇbâÁ\`w~5YÌºé¹ÁÅ½ó=@J'Ys%ºxMûiEeI¥v\`jS©Ò9Øï¦t±!¯"Pô(ÍÅukÆá²á}r_éùÉFU?¡1iÀÿÕÏ0GèCe$§÷ÎÔÍk\`§öÝ§{}hÍ½ùy\`ð¹ïsÙ¬BæéTÿÂ¿ñWÝ;¡ïò	MV Ýèþ×V©)k=MÖÓaÁ¶0ý½@ÈéUÿÛ­qZ×yöà¨&G!=@&cé÷¥°;ÙÜ¼6·¯"fZbA8òßÓÖÖ¬·	¢¨ÜÞ#õÐÃe|§=M59Od¦¾é×CãLÿèôü¿ØèS[ì}ÝûJÃF*ÏZÎ~N$~ZÌ£éû5àÇæDÓùE¹V@ÿ "Ïeù¡WÑÚC8	òÌåëAeõc¯PûMeÿánß mPÙdýq=@Þïæ+E!H\`÷Ûe£&uÌ½ØgÝjÃ$±yè%ögy	ßd8ÇÜ	¿¦ët'ØýéE~ã%k}ÀIâ»QâÇØý=@Hâà¤åâÓÕ(âÀaJVÔþ=}~Øú[5áGèÃQ©×=@ûséÖ©cz¯÷=MÙi¨õYüãæ7£Õý§úÒãÅ83XHÒ=M=J£Åy Ù_ìÙùUzâ"Þ¯8iò=M°ßFZ#ö¨7¥)Þ«iI$ÁØg=@Ð­É/?µú"æ7Ñ#g_¥y	SzèïÒÃU IåRÖµhaIã	þÌù5±A8¸ÐÙ8"ñøî!à­ ÃÚí>¬¹ÀÁ¨[}ý~Ñ½¸8G@cjè#Ð_¢=@x)Z}fÇ&üBùßÜÒÈ58Çd{W±îÅý³ºenbpbü h±ÑxöÞ½ÎÒS+#GÇAeÙÆ¸$Í?öÞòË¬mýz½áÒ£Ò"öñ	tä¶^êYÔ!U»Fàe÷Ä=Mêf/ãé±ð8Ø}Ð=M¥ñS/±mâ}ëKæ»=@^G!8Ë§Æ¼Çd¤c "3² g¡° !·\${ýÚý¦½]Ø8ÊG#y8ÇùdcÄPcà þðQîþËÝSÁÙ85ÍýêãÚ;1ÕâÃ¤·Ó½õ¯ gFÅÄ²{Ã¹ ÈaIpçöFÍûA8åûÌ+XHpøs+[HÇdÁïb=@[[±ÊW±F<Z¨¯Ç5ÂÙd¤ÅÌoÅÍFÆ[ûÕ.NÔµ!Qc¨l	qY²È°Ê_Ï!ä£Çý¥þå0Eï^jH×71v¹FI æZGü e¾Ü)óKý¯=MJñ]ÂÏq¸ÆÊ,]B» ¢Q±üý$ÖíòÔ¿õ¿3UVÞº=J*VÒ¸pô¤! ÍÁ¹ÓÅ\`X#=JÅ=@¸Ræ¨Yy9QÝ×ÞìÎéöÃú÷Ô ÒýÍ1B$]iºH?<<F<¶©÷°¾9HÕ·DÅ¤ÿÒ;ÍoòúÉy]¤ùøu=Mq©ßÉgþØÝ÷g¥ØvgØm¡öÅgÇeVåæ îáÕ¡Ýü·éPÆÜ!Ù©Ha÷Ô3Ùv ÏÕ é	_ØUåP[ÐqÙ=JD_¤þÕøGÑ=@Ü!ñyFiÙU=}Ýè©¥.Ï¿'/ßIÉyß;iÙrièhûök&¢Ü×Çe'"¢,\`¾$ø¯ÚÁ	&CNRåfÅÞÍA©	ñüäë{u§\`Ï"Nã ¿»"ÛÌ©ÏùÖÖY³Àt_¤Öÿ3hs$6Ìü8³hÊáî.²´jó{Tÿm8]süjqs¤3lPö¼ÄJçnÔLs}»ç5ÖÜñú{]Àóf§=M¯ÝÏÄ÷å7ÞxÚ ùÛÕyÛp\`:Ç\\ ôQçö=}|À_i/]x¥Òÿp<ñöàî÷Á¸Ø«Ôa\\ZìCñÙhò}ÒÆÏákS=}×äöxØë¿Í=@'qÏÙô}lTa	Y¨ßå¹§øætçà§±·Çã¦«áã/¿´Ò	KP&&ÿå8æ VzLFC°¹Çç¤!ûéHe£$Á4ÙÐñÚûõáIäòåÓô7enQ¸k¥¹©Ü,Õ	\`ò!Èæ üÞ\`ç=}ðùÅ$]aùºÚ0×%ð¹ÈãûéÈdã%ÖÞ}É¾éV¨]&Ï¿ð±ÎwÈá(ýaÈeâ>RÓ^^êdûð§ÑæYzpKPÞïEþ=MÉâ¢°¾¶úè	3Ë&xH+OMDÞ¹sÆZ¡È=MÈdå1>ÙzÕ£ëÍ¨k)ÙhùÚ¿pG%QyÆáóÅYG­õ§òÒÂ¹]abå¯pÿÿ£j"Ãéb£¿åËÖ¨±3ÍÑXòùi6RMÑCu\`c¦ø¹ª_¸uÃõÙÅÓ§(ÏMEÞµxj°wRÏÈ¬MàiK·1)¤O=@&h]³_AZy Ä¹ÏÏ£é"ú''#Î4=JÝìÛ³0ÛxÇ»ÑªãVà+¤Y,õññÑ'*Ñ¢MåÞyÐÍÓ¤ðÅ	c± Ì¯Ñ7Í¯ÓS=}õ-!4½F]GÍT¡ã#Øb°âFmÒ§!¸Yû1òï´ýÑ·BÙÃÈyw¸ø1{mÜ}ÑZ×*5Â1c Öûê§èÓÓ#+$ûÿórõ+]gÉ=@Ó¸B³IÍÌ·v áÛÒS*§Î(îÌWHMßaSæó½õdÑ*ËÑiHO}¾é±Í5ðÖ=}·fÑ<ÇÇÒ=M$üÿ	£ÙL%ö1·¦Ë*¤ê¸½×JØxw÷WÇ=}ÇuC®húývqá=}XZÐÒñÌRÁ<ß=Jg$Ù¤hZ n=MÉ´È^ïoIo®=M/á5OÚÇ·ïò¯cEÇ¶"Ð£·Ê&ÁW]ZÌw M¦Ð>3JÉá¥[ÔÅÍ x	¢é1(Xñ6ÀïÅ·îÅïQ@Ï(ëã½Ñ]·¡G»¹o×ÍùMñÁBiD'²ÊéùÞ!âÿº]÷|}þkWÏ9·ëNñ4[lbo(dÌT«z33áÇ]oõ©þÌßÒÌâ/±høQc¥Ý¨^õã;ðhàvê©ÌyÁÜJq&Ç3äÒ?®{àÿSàÒ»Å;¬6E+2	|+y¶ö¨Iõø(Ðße°Fw/øñ*fÍÑn=}ÕUkÌé~=Jî?ÞÂõJ:i«NV¢"»Çe\`XÆeìºk'å¡âp#ÜOµ10"£bDÏÖYyÉi%ô?éøÄºþéyåp7ÿ6YC½ñ¾\`ÐYÞ'°ÅaF¨	 Dt~nÇâÀñ÷Äæ¢fóÜÍÂ£Ékû5¥£rÁ[5¡_ÛßR¼F¢¤ù¦ Ø£§äÖÝÌÙÍï÷w<RîgyÉ)£$c³çmØnÂ GllÄH@I	Õ á[=M@hÂýÕh=@ùÂ\\fPÚ6R3ó óîî=M%¸\`àù He=@¸{Õp×ÒÒ=J{ÿÔ;¬¤6è­­ÍpÉ©évvgØN¹BI	¥=JÛ=M%Ø·XEæù} ÷D¥Ú)¤¥ð¦^è)ã×¥PîYNNÔpëXõ¤*iZ®7ç¤ÞZB¤î6u2#í1Å)áá93ñÁ]D !ÄñÁ±eµeY¡á;iêÀ²²eÅ¥¢8âÀG=@÷áÃUr°eçe²IAÄ%þ£ti\`2A×8æüX&¢aè Ô=}ûÒÒÜ{[%kn6zÓl\`Ýr,MìR?ÿ0ó/Iqr¶bãÃê0[t/GPTæh7^rßýÂÊfÊORï8^<'åcÚ®U%Ý§Í£ªBägYü6;	è|á¡¹¹ÿXÖëÊ*)&¨#¦§æ+®í·­g+>)bÔ¨#!±gG "ð[Èg¦¥#5¶TÜÖìÑ9	ç§¦ »í©ßÏ´Ï|[ |_vù	N!pÖÀÎ7ríÎþüí¯¸ü§÷ß§éË!YûåHü³2Sv4|±Q TQÅÜâ	þX=J R9$$ #Í¸D=@éõd;´0$¤ädÅ©^%½ñ8_ãyç¯&æFÒa·MeøÈº^ÊÅðß¾ôu>SB=J½ñí÷ïóûëxææ¡ýæ33ÕAùRWy<äJ4*M:=}m»XÉ±	ð	¼£)¨ìüË÷Õ@9kp=}C7üµgmÕL¾}ØfÉGÔ+y~Õ#ìØ#ÓçÅqR@¾Y¹åÝÍ'ý½½õEÀÞ§%TÉÉú\\æºáÕ=@áYÉbà |á$¿´$Oj)#gÆvþOæÖ'¿ä¤ËXü·ö/½Ìíµ¢ºP·£ÀÆTVPgs÷MçñV§æÂö$¢w=}õý­S?g¶ü@_UU§¨Å4è üÁ Ï!Õþíp$ =@Ë?Óì-Æ·ü!!¹øÂ;á®áMÄ #·­¢|/2áhb%(u#d;h§%"&«ÓGL4¤búÃÑ!xÅékÂÉ5w\\^úä^~ÄÁGqý¯Þ üÕ%rHIÓ¢rÉÉÈçÞe=@ñÁÁá¹DPÖ§{vÎA·ÑqQÎàT7Üiõåý%ÿTk#$ ÞØ+dD¦§!=J6ÿvÁ	hhåÜ)þ¸tKyûäÉhÛ£ªð4âûTÚâ¬Û´ü=M^øä¸üiýlÏÙ9á[t	HxÕºèççæÖ}qs	øB9÷" (ëÛo§U¥}MhhãÚÑÀÏgnèéãà©{×lx#""^iVÙbô¦)&ðY[ÿmÒVFkU#eU%ñAµÎ6Dr?ëò¦Â0xüÑµMµHØw×¥~A-ôx/GÚx¦¤Âcüw÷"üO>èæãÛ¥>aú2¦§¡)ìèhÌg	hfãâµ<È³³hÚ÷:[^ªi¶ÐGU#Ãß A Y¶zöm*Û OÝÕë=@Únouí §<ðäUÅ)ºéÁÓÚñ1÷Hh+KOÝto_ÓùÁf«ïôo=}er&ñ4_ÅÞUÅ¹Ê:pÍ[e«õDX¬%'"ÓÁè<ý&=}¨&MbýC±c¼*mü§C}H'c[öRYÛÈSÉ©1UÚò¹=}Ç¢AÑbHx¡RíPÍûÄ¨7ÜÄ·áßüÂX¼Þj»Ô|Î§\`´¾$6éñ§7ÚÚÆ²>×½O­¾¼¾:dþýn=@¼TX:MÉîÁèu	6$an*Ó(bl0tü¶4«~¼¦´uü+2uu¾ÀÎ±rGÚÙläså Cfq4kü5À-%NÉ/Ý¯C)Y'é)ñn2t2v2u²sòt²sò¸³.|3W3,Msm,r+ç¬nÜR=J¹~.S>3bnËâN=J9¶~8Ó,|OÎÎÔr®ánBºrOäP|Îär»D|ÎÐr÷»Lßpu;òÜFÓ]|æKn·þAS0S@*üJNrYOÖM|,üÎnLqºÖrrÍº¨LFü¢Î³riMwkÄ°^-AÎrºKWj®Þ.ÎrU»=}ß°ÞHMüÎ×réKj¯Þq²ô}ª¾³eüINøkd¬6.üSÎ]rºXJ'³C4ü_ÎEráºJm¤ª23ü]ÎArÙºJçm¬~$®/E3zïhª#qì0Pµ¿vrJ.:ëA¹¸³¾1óEóAó9óIS*S2³@êlroºl»´M¿n¬0È~0ÓF|/NR	trzèª:¹kÔ¸~=}Ó\`|Î$r7»DM_o¸þ<Ó_|NÌeLÐ ZsqZolxpx=Mn§Ì¤»ÀMÌ ³ÞH=}|Jë,Î¡rwÛ}pô-Îrp¤®þ@åÿ3ÎÄj¼vN5 âiºD,XMï8 7AJyC¤ºúb©¢qº°-Ãt93ºÔÕ1ð6²6AøM=M«G0Ó*N!ëæKjñ\\+Ðª-P«i?*ö,üÚ'.%CÅFJ=JFY]ª®A4=MJÌe0Îl[¾3F9)©åªºùtËx«¾uôÌWjö¼jö?ûpJÑiº]8$YªÊZÂéÍ'0N5NçF¯è=@jÉ«Ò@JG¶og¶3ºßWº{M¶=}¶CøUÅ«Úw[;v¶«Þ«Þg«ÞkjZAgZQJrì%¸Ì[j	ªâýªâ­Z³W«â»jzJØY:C²5î¿«âJKOJØ]:A²E4î·.à.8,x-*&0îç0î_÷pG{¦þã:YpEªÞg«Þ«ÞÉªÞË×Eúwe: ]ªQùxa$àA§.ÜÈ*Ü=@fªèIîB*{)*Ì\`f³Ûc·[,¼¨-¼(31.g-êµå³[/H+8©²Û0-X£Ó×§Þ :ø8Q*6*¥+¡bPr.ªÑ1ªÍyªGU=J.Ü9bïæö]ÓögêF8ñ¦»¶ö0¢Iµß íZfñ"¦ìbWo¨õH!ç²$ÚzÎ;¢=JKuí«Þ6²Qu±¬ÀÄ4GØ¹óü­ñb&WºüÄCN%zFº"Kº|Ù7ü-©Í^æè{M¶|Í^ ä{Þ»ÖÎö^EëHEý1ÆÍUtæ×9,	Ùà<µÜ½üPs9øsí­O\`:t@jÖÛ8¼Þ­¾¿JÅÎ1ívüÑiw¼_{t=JRko·_u&¼¼es9 bsíµeu¦³Ý¾ÃùoDeýoïødý?ü­OüÑ|=@x¡sØKº¦1¥töOÏ×¼HþôM7©¾q}tÀôüå¼dâHß¦Oõaë ¦üÑK¨¼ß¦¨S¨ó¨ÉéeÛªî0r\\F3gª\`Uk<	CV,;ñÐ®rèç5s=@¯ÏöoÎ1¿´tÉt±tïµK©óhÖ®ãÎî¾¼ü¾ÀH3½°Ñ¿»ìÜ¼¯Ám'OÁ´|ÿt¼Ï©ëÜý·T¼_JltHSÙ}N	yvV¼æNt¤Ïä^æ§w³|ûd©ó~ÜÐ\`º\\é\`¾HNaÀhCÅt½Åsj5ó¨uóá{³gMÏwQgÒü+'RÛ/ÇOuÕØB)¼ÏH|=@¼jIk~ÞóÙÉ'FU=@ÿª}=}=@mv9ì=Ma=@Öÿµ\\Ûàj5s4/èÅªÝêã^PdËk¨Qó|SG0ó$:+ªÁ·póþp2ü)¼×¾ÀQ¯ßÁvAË¬æVÃ(¼l±ärNuh9[YóþeÙ¾£ðqÜî$sÐ²,ük|²NéYL¯ØUXÃ¨WWÏUQÏÔVÃlMÏú{¼æÜà¾ÏËÞ¤¾@úXê=M¼Ó*~¬¿üÌñsËÕÐsÐ8N£ìsØâs\\M¯$F¼üÇ½V/tÕqh½víérÃ¸¸25=JUÅflÿ}íöç£1c^ªtESÑwÉSÑUÅöÃüÉÜæ)ãÆ£õøÚ$ªëJÃ=@ìºÊë¾_óÚ¤÷D­Ïÿ;mÄ'Mm+½û^çâ{x¾±9\`Ä@ø\\°h÷ZÐçÞ¡Ûð~ßåw=@S\`Àî6EýÑ\`Õ&]É^Ü¿íp°§ÅàMîXqeý¬ Ë9ùóQf]Å_ÝÇdíþÌçh±öDGvGeÖ¸¤=M#ÐÂüüQÃlØÄvítdô}G<AGw=MtÄm¸[Ñåàç©»½çÆ£æÑÝÏýóXÕ!W+Á(Wó_}í7(ueÿ=M¾¥pH}HÃÅ¥ØÁÑ¡YõYæ\\Ð[ïââfÙOgìe÷'yúsm§vX£¦Oe§ðÇÃ:¿f^å#W§'Ùcd_Ëjõd+ÀäZ% L¬\\§å0õïì4°_®ÂÔ8säßú6Ù+ÍØ]Ûxà1+fCJ=@:BõüY7|jÐ;ØAÏß©s6=JE_uqèårÜfÎ¥ÑæÏü}&Ï\\ÇlÎYtrÿ4üÖOÿÎà¿Dtð÷Ï4ÿ%sÖÚÜövÁÉQO1GÀ´FãYgô¼ùßYW)Ö×â¢ãù6£Èõ1ãî´°G½6í]8E¨Æ	¢m¬ÛUðØ[ßÈæ=M	Kìà ­àÐ$°)Ò!%+áäe6Ô}ì~ßµûÅq¸©âÈ=MË}0Áâ!Ï×1äÏ÷ihÛù¶Wæ¤1_øEdù=J=Mc%qîXéS%~) á-ØÞ63(#=MÂº9_÷o W<¤Ñyt³f#0À~¦OËñT>SæËý;åùÖ¨|·×qàþ	Óð	\`æÞÕîAGÁÆ½ï¥ØmÙõI ñ¶$§'Ê	¦N=J¸S(Êk0«8Â°g ºHOBÏcuÏ4ê¼-ÇÏ¡gÏÊ	uù >¿ÐÀ=@R¯¨W?$b´fÞw"ÛÞÝ®¦¼&ý»W7å´	[ÄúìP:Ýß¾¡ä'Y½vÐ®Ç¸ÙÜg¤ýÏÍÞ¥ÃL7çøÃÇ{â¸	§+Õ©SD£¨å÷tñHèó´òØÀ8_Yüá"xúç(¾+!prô,kXÙ¼ÏS[pÿle³?¼\\Mr}àA¾§7ÁÜÄàÁù=}Oâ]üJ¡ôÃ7ØÑdE1w½¿BQZ(ñâÚ¿½f\\5'gÏ#,Ùüæ4§ÈÏÔá=Jä­ðõP¶¶÷Þ6Ñzý¬v¼¥3yîeWNDÀÐy¿i½m£¤e­åæýb×ìõ¾¿ÚÚeèÈñ^ã#¦¯0 ÑW§ëäXÀ?ýü4\`÷U'«çî¥¶^'OS&#ê¡mªî\`ÜéÓéZ5uÁ#ÖzNn9%Q"¹	ââ»½=}Ï!§ÃÇ6»£Y&=@gëÕk!J#êâdMUQá¯á	rå~îíxø¹èÙ!Ýx¦|[ñçhð#ÃÃxXûi/%hÉi¯Ã&,ÄÖ< ¬Vú\`ÊÓ¤=MÊ}=}1ÃöñÄôT8mJ}î#¼¼^á×ðY°IZtYkÕü#¾Bt¾¹øÐ«Êªùÿº|kQûjúÛÿ"E2dÜRòXâH±'T?1òXÊsüK|B®È«WBz R;vTAr2æNISé>6lÂ>K_,ó¦Î¨wãvû©Y9}³©'¥ÞûÒàÏtã¼o,£DÀ'¥¡ÿÎ¨Wuÿ4Ïµ0¢å<ñutsBÑ·no~VNú3÷DG\`â¡ WßåË/'çFÓ=MqP7´ãwÝ0ßÔ¯ÍÊ¦Ø=}pQð7×mÕPÔqT}fîudY§y=@m$üØoíÒÙ~+£¯ÝÑ¶I¿FiZäqÑ=@wÓûOç8)8Û'ÔAøsy­è-?O=}Éf""=Jyûîß©û#©Øy«T8§ÙC#Öÿá~_@Ý·2åDHÛws²ò)ì²]Ù)²"hîæß»àµo¸UÜ#'H»=Mqp¸^MÀ»þÇ»"ò@Eo¤w":|òã&=@mPjìÇôtÝt¤j5¯Ðvhbz^õÔ^idoÃ§Ð\\&ôl=J?ôOé·ôÁXe>!gÓÚÜÛõt$È´}ñôÙ?å>ÿ÷ê,Ûºo¸ÖóAfÙQÝþ¯Ì'º{+¾¬(ùoúÎ¶ßU÷¦5Á9Øpf? ñN5u¢{­ÕþoÝ½DÛ¥ÄÜ'Úó¿Ýè¹ÜÄ=@8ÑxrØ=M¬Vy ¦¨âYeåb°FõÄ6Ñ6!7­pñKVózðyîÛ=@¡=MÐ¥3=@øò=J;Ör»n =JLúS³â½îáwC%½Âª> §4åM¯Ç¤Åì4±ÂÀÐ¸ÚÜÃÖ"@Ud#)ÞÜ»¡Ö}U(ðôP¦ÞÜíÖaUÝùÜÜr9»èK;.N¸Gz¿.à|AÊoJ:í+2­98*ñIuåïWªlJêï»ô¢¡\\|¡UÅ?¨pG{ñU5¥¸±âè·%&æ¿ïFáÜSéÍèÀÛûô8WÝ\\©Þ£	NUßÜÑ­ÖVèå¿ÿ'\`aô¨ÝÜù	|¬ñSµS4ßX¯¿ÄÃìÄ}ëSv=M>À[¯çòÉìE|¾1óÛ=@\\Õ_gÃ7GÄößv¥UPÝ5£½î%N $¦<¥éO³ÿÇÄîÈuN[éºNà$¥LE¥S»ÆòìPNÜÙ=}Ã¡¢LEÄòL· ¹uQ¹7å¡¯;V¨.5åfÆ#ÙCø·BøHÿGø8%6É9³°Ûpíº°íÉõÇ. §,Õ¼ºêhÛ.ºê$É´¯ðÝüGÎÊ¢@i¸=}ñïðÛÒÚb£g¾ÏGôÔ8GôT¿IôðèCìtCì49Fìu8#H9U0ÝH1]ñ&­ÃïkÖ>26-õG-ÃË)jA\\ºåfªÃfª/p7Í	©=@æ©àùÉ·EõÀ!µ(#µÍ'Â	¨s¨V6·w´ñÚAÍÎþà^ÕØYÅ»Á_VÁb±D±×ô±ýÅüÅÿÛ÷ÐÖïôÿïThó'½ßXÿ½OÆëï Ç¤Z¹ßd+)Âò¶©a ÀúæUÖ5\`Ð5>ú¯ß	ûÃGþÃWæ³rî0ä¡'Õy 1å 	àwñÞEæÝëÕÛ/¿Û|±ÜL×ÜÛ!ÚðmZÕþ°£)Ä#"àMÁß×tá] ßÔá¹á±ÞEØ\`¹¶iðH7ðÖÅÜ»³wÖPþÒPVÉ§=}  ¦ Âw'ã;u¡îv}DÜX7Ã-ªÇÉÒùh'~¹·\\þ=@¾ä#ÑdþúdVo Öy@¤å@%ÕWPÇÕóÿÕó=@=@UÏa~u5iù¸YÆÌ~5õ!àDåÕDU¤ÃÛ¥BÕÚ=MO> ¨N=J>óþî2=@@ÐTf¯#ÁÕì=@Y4¥öÖ l=@ O ­tø ´VPÚLEdè,% ÔfÝÈ÷òVñ@AWñìÐ¾{ôÚuôÚf¶w83Eñ¿WÉÀ·uÛÜtÜèO»"<VùÖ|Ö!ñz æRççRUÅÑRUaÎ2=MÑ5ÝµO5Ý=}4Û¿!mÒ:à¤kkÀ&[Â@öx×57¬%ø«=M¸*òWªª¯©ÀÉÏõùp!#¦&¦võÄ?Í§6À÷¤¡ùõ¨'W9µáùíß¡¥\\9àßÈ1uÇøHf9UåÛûÈ5XkA §Ê]~ÇqQ ã¿ÃòäiaÛ[P¡Þ-¡üÈÛWäÛ£Òá\`ö_ü°o(ØQ6¶Á«WYÝØuëQb½ÏÖ"£iµQïqOý­Ü¥=@eïX=J×Ü#ôýwY¾?ÈU}¡gHpf{qôõmOù!¿EÿS81RýÔ	¼ 	~8åË6}ÙS½Ô (ÏY¡SßypoýÙ¿)t)Ã¾=MXÑ¿xTéG¼±H}fhÌ>S¤ÊÜÒIô®¶	¿Ñ%¿­é}¦(6ÏÑgôÕèå¿Ü©~ÿË¾Åæò\`ÏöWô=MO¦úpï$¤Ïçt¾ÓkÕ¿;½TYYÐNGÔöTánÓ\`©»\\ìË|Í	¦óããôÞT¾æuS ]¿'ü¿úÝý?Ïô£}¾¯iUwåy|ÀHÆÊv5GÙ.xDÕ^£(½<Þ\\r½qÄ'¨´Ü¤Ì¥tLô¥­>Å'¿K¾²,§¾©zH(ücÿÎ½¼ùc¨Êßiã¯<}ÛÓü£m¯YÙÑvz#õÍ°\\_Î¼à´Ü¨oÏ=Môù7í¾RÓÎ¼æO~³{ÃÀÑÊü)ªOhéO H yHt%Øôñ~1Ï¯ÕÎi»¿Á	LPæ¹F%oãT¹LEyåG£ë¿ò	LYnDÆ¶!=JzÔÃ»Ñ¸&' =@ò¨?=@qøEåLÜo»µ´÷³vsÆH#(îr(ÉLñ(Ã>U¨jqÙ»Aaá²ÿÒ Î½ò¥tn58²V»HãÏßw¡ÈohA;®c£kn·MMh\`¸"H¼YÌÂ»Ô×T#ØÝß0¥'øÈ?½´w5â!á¥A±W%Åä¡ûõ¥ø¦åáö%¶C£vt6øædÍj·ò¶UV½çù6=J¶ñÓC¨±ñfu"cÍm»¶A¦EçNÍãCÁòÉ&ðûT¥]è		ÉÛ$»¶í»Ñ]fæÂ{$ß¶æ%bÎCô§öÂ%!¶%69eß y½ ±½äëwç=@=@}ÇçPÙ$"ÝÙ¤äÈé¥Ê{kÏLÔ^ÐÂäsC~£á¿þÈàÿCw>ßôfµ7ÓdÑ®$ú§·þ¸8÷þ×·Ômà{Ù@5Ö$ÐðØÓ0æÍÀRywIdjÛ§ÚD'Kxgâ$l¼då·E»Ð=@GÏ[g¶d÷=@þOQÔ-¹x|ÁÄÖ8_vVÂÐ×fmweÁØ¹ÇÓÐùYÈÍ(Chy¦ èdf¤ËúÚ^³b_#=J\\ßu±?óUÿ­Õß'=@Ôw\`Ø}pz	ÒxÝ)£µü\`ßé) ÿí8_vÏÈdÛ§Ùds°ÄhÆÕ+ Ãë'Ìê-Þ©ÒIUG|ùiÖ0afÔè¢vl's¹«ÑÿÒ¹þ¼=@R5³Aÿáu$½ù?ß&ÕÔ©êß=@¼Eã=JÙááºåÔ$g¢-ß¼±Ô>7Ã)nvG»($|Wa¿p×¿&gÇäP ­¤#qßw%ùû]þßèÓé(Ø¬qô!ÆÀ"\\	<=J¯èB¢ÿ×p(h°a9à÷Y¡}¢ )Õgä«I½&F#õ}¸&÷R]É{ó³É£îWKw¢­U©âÿ¿Áð§ä1#Ð¢9çÚQ	ë½yEïÇõ+áí½±2¨ËaÙµ9ÙÉ$Å#"èRi$ö¹éÆÃÉ¡Ùù%f	Ñ?=J¯Ô.Õá,¢ë«&J#:À>öù1?¡8@=@Â:èüß:Úß:úÔZÓZ´ï»oã#p{È7ó«ï"Ò§ïâ¥Áær¨k3(Úsh's(¥¦ShÝ^	àÛ^I|i¶âIð×"[éÜ¦ø#=Mp¢ð­Mßf©«Ý·?¢?£)Õ?£÷ë¿"¦%ô¦ú&ô&¹Úhjbé	ä4	â4)Ä~¿¡³=Jðï;f]V¼©Aóa{"¿E4IÿÉCÙ\`ËDa©ßåÏÍ¢Ág{æ£×gÇY­éé}­½èÕó!Pÿ9·ß#"3ß#,ádæúödfúÙXÉæÒXIzÚHù{¹¹3×ù!Ø×ùåÁêqê7ÏEùEDÏD·¢tðæðæP&(üP&«ÐæóÐæÈf t]êþÆGÆ)(ãc	[â/ù%â/éûÏO!"ÝO	þÊ?	»´AÓÄuR)\`&¾\`&åÀ9EüÀáçÀYû¸agú¸!TÈ	üÈ)«eP¡=JeH=J± tq}Ì=}gÝ=})¾ÿ³ö%Æöõ¯¡@¡ä¥'äTåÁ?å±£¢!æ¦$£³lg¢Ë[g¢ô'Hæ|×ÈæûÈ&9YháY¨lïe#7=}¤ã¥DO%$%7a%+§#î§ã÷Íè&\\µÐÃûf's^yÖ@í!Ðñà9¢=MÔ'"É%$a$ðÛ¦§V£dÀñ/a%O¥$g8-¢ÓÀ-"ñï-â	ý+&Á´-£þ«¦»«ÿ:é	 :!\\²ù¤Z²9TcÂYHfÂA[Âõ0Üô:è]2y	i®IZ86ëÍ±Pé9bè´ïÝsæóØbHX¸6µCû¦Ü¢èfùÅa«Âê¶x=J×!N!3éZhÌZZfBy¨]¶1?DøàDøe¶Cø)\`Æ)¡b!FëEë±î¸=J5¶=J£)BëæBëi$PØÿ=}£è¨³fbg»¹½ò-Q±NË<©^³Éµuà¼"ÂgsæßNh¥<é{JÃù¼#ÙG½#îèx\\ÉègÃÉeÅöågyö¾ì%@váL|"ôÀS¦¡4!%S¯IÃÁì9xø±|"üUS&ÑAS&a­¿Á÷5ãU¹Ùo£rUIàÍÖ&>U!ÇéÖÞøÖ¦U)9U)Î¿ÑÞíÖæ=MU¹¦ûYÖ&øEU'ëô!¦ð¥	Ö&ê¡&øÜùb%°=Må$=}øÖb@ê£á=J?U¥öô\\¡%×ÖnUU\\úô_Ý\\ðôâË±bá>=@p4eM¯WÁìVóÖ\`\\Àö¸£=JÖ¤d³gÂÂîD=@rYhOÜ=}<Í8³ÖäLåà..eM¹ÏÀ7QÕ98q67f°[Å¿3öPf+ðÝåWë§ùb@!¢RÕûR#2%Õ!: ×ë©ÅëV&îJ­#7-È¦-û-Q'®P'¶WÛv ²A$!q¸êB NXÄÿ/MÑYÅÝ9EÚÓa'ÛAu|¤ÛÇgª'g\\Ó1AûÇwµðDÖôP	ì¤EVÇÞ(ÇÂxqº«Wè	ÈÇ\\ßÝµßÞ	¤Þµ|Ý¥éÞÑÞ]ÚOQÄÝsÄÛL9ÄÜâÁw9·#Ù·7·7#ÙÎ¹Â=MäÖÍdÖÖ Ãuw\`¤}7 ¨@b\`´CÈ¶ôÑÚÉMuà×ïÉíðH¿¿t°o¥Ífuz¸§tVõp=@Xí¦í(uÏÂs=@Ô3QÎb¡a¾w¾g~®7Wö4Ç7Ð/kOÂïç4\`é0ÚÝ÷4Úå¼iµñßøñøsèö¡¿a=@ZYôµ§Åóà¾!ñùãÛP­¾Ý5àü³O]Ý=}©Ä1 ràCà=JwZ=M -uÓKÝ&éS'¡©hÉ&ÎFç#ã%·üuOÉÏà=}Ð%mÃgOëà\\=@°<èÔÞ[´§äÊV¥¤c¾Ü"ÏØM4)Ê§´ù=J§tC´~£áý¥±¼ÕÜöPÁß¿ÏÍ=@RÑØ~´¾Ð»ÀRíùVz¨fã;euÃ<ÈØV\`x}G)ÛÇ[k³]¿©Þ¤ÔÜÇOT¦ÒÜÑ©òç¿°OåTÁà}ÜæRw©Ò©}uÓÿãÄ¦NcDxÃdÝ®\\"K±*IOùmÛ8]U£EïéíòëøYLm!´ÿ¦M¹m»8å¡oæXÞ{ýL·¸bDEcìà£^ÏÜb)òÙ6»q]xoÞTbaÌÕu²iÓDcÌÿ}×¥fØ	ìôçÀº¥^>VD¼[Ï¼¤¥¶ñM°b\`M¤ð u]ð	ÂûWMMÉÍC\\(ö"p	ØÙ]¤öôÒÁÑ 3i)Óh»yW=}ÎØ|nHt%Ýæ¤à©¶w¾eå¸dfÞÛÄèÝÏÔ1íÓ"=@§ÿµ1ÒÓÇ=Mÿa¼þ@EüþÞQÍÿôoðÓ­åx~mxÈÃÐÈÚ%oà$æ	f¬¯OßyõþKKÕþ}7Ô=M\`Ò©÷Ö8}áÓ¨a¡ÒåÝ Õ'zvßzÝ-%è±þØSqÿÚQþçuxÕüÐÕgAÿÛ©ÚÐÐÇ+×¢àä$g±ðÛQ=M	ÉÕí ç|åÖ¥ÕøÇ)k÷iÝ¤a_à¾î·uüíòÑ<Y#8 æë1ÊÖMa6²]õ¯¥IOuâ½f"þQÈ&lÇff¨håa	ôÁ¡É¹a_=}$ýô,&%*¨æp:aw5s4ººl&~®±çSôqÁYði9SøÑXëÝ¼èr¨Ñ}BiÇ°IgÀÉ&¸)Ö,©ÐL)Zä<aÖö)6ð"Õê2¨TT¼ùÐðÓ¶iÄ·!#÷ì9H¹%7ÞÕï9¢ÿ×¬ï#ù»7â³__¾pfÜ(Ül=}Ø~}hfÎCÙýÆI_ß=JIhà=JQß7yá-¡à¿@àýïïüÈñ#¡=JÀ9G"ü½G£$ÙÇâ¦HÕ5	¿è¿ =MÕå@jÅæë5óð !4!IÙÓý%îD§#ía§#µÍã}'Bè6éhÕI{OÀa#UÀYxùÅ¥6=Jç=@6*·\\ºÙheº\`²á©c²sFö1C±=M°Ë§üzhý>ñpñS=Mâ^BÞì¢¨Úo,!Éêá¾BðÎ9=M¥h7=Moe6Á!6Q¦píº;¦"û;æjL9C¾òuqÆ¼¢¦ÕN£k<I£U³	6x3½£/óæïhS¯~uÅ0Ð5}"MS&Õ>HËÖ×Ç¿AyÚýÖ&=MTU½}x#(6%Ùá(/éÛ1ið(¥9¦?!×Ö;UuéÝÜO×ÖîÇ>à#>XÃì\\YÃÿcÆî´wIÀPÜ¶Ö;VßS"áÝ±Ý,±[½Zf«ÿÔ?ù=@ß´·d6¿­é¥ZVc²¡Bò@ùÀY¶ÿSB@ÝÏY±÷æÿµç½S9åÝ³GäÛñ1åÚLÇ¾¸ÖÛ QÁ Ö£Ç\`×îoWp]@©Ð3%MÀç+åg£â8uµ¿Ä­¤nÛ½ÔÛÑMÛY{§ì¤Ùtö£$õÜúñÏÈ®¼ÖÖì²Ìóõl¬	ËjàØ+à¤ÎIe©ë±ÿ5øõ´]äÛaÇÌÑÃ¯	¤Ü17Ö×VÏ'ÊyôÖ¾º¿ù¾ÄHR;S7=@+)¬N¾ÌàdÌR$å\\ñ=@ôÁ¨Å¾Þ,¾±©°îVz$ù|(Âic~¦¬ÜRúª;tzvÖËµ<çãWÚÀ<"èÜ|"!ôÜ/¾¼ß¿=@pÏ©!»%]øp(Ü]¤/»¶¶åØù&#LbH³RàÜnÚµåu=@BÞáÉ¡ \`rU¼»[MyçCÀî{]¬%ø¨ÅÑÓç¤àÁ$ùJã¯Ol;bË¿¤¡ßó$«÷·óÔÉþ¯±QÔø¿ÑÕHuÕç¶µ~ã¤õß=@ß¢·ÇÏ~W +ô÷Í=MCßÐ)ÉóÕ¡þ"Úqè=JAù¸þ£9hÕdræ_Méñç=J8Ã#±XæoE¡îµÉb¿ÁÙuÑu#ø>=JÛ'­"Å:èphþY¾IÄÆùTï!&>ð5éRõ¡^ÓêØÓî¦3p(>³=M=}=JF½ñÖ÷)zÁñÞÕùda_tíÐ¦ï¦À¦Ý&¹"YS"ôG¢áqG£ÓÇ£ß¼£§"&äg"óíg#½ò&øÔh¦ÏSÄA<íÖñ-Èñ;¯0\`÷0ßm1½0ÆK&ëæË&ÁCfO_ÈùÀª_BYaÆYf^Æ¥Ñ¶=JË³#R'øs&ìÍNýaÃU¼£ßSf)Ü>¨&§4Ò#&;è§×¿ùcÿÉ#\`=J4=Jd~l?¿qÐÚ¼C»î´wsÔ¶¡9Ø3§Ïb Ëì:Dîùh¯}ñÏá ÷¡ÍjxzÑMÕ£ÛW]T×þÖ¬pÖýö¤¢vW@J´§:óÔ?2øÛ#Ïï½¯¯BEDòu$ÛØñZðÖùXq@àÏP§ØÇ©×æ¤§Ûh&uÛ=MÎ\\Ø¨Ïû½	¾WUwA÷èÇÆÌîEÓÆf<Íþ~3|sc¡]éÔÏk=@~¼^a\\uÇré¥LNÞýMÿg%äâ\\íU=M°µ­dîzW)J|Ü·âûÿM¢¶d °(þLlüdßÆýX_I%mþ=}ùÙÓwf|9G¦Ñx/é fNò³)æóÇ!T÷¡ÑÝ]­¢È¥¯£çQï£Õæ'&4¦~÷T&3¯©WÇGÅQùÕùqùö-°^u´Þáá=M15ä;g"ÏÂèl^9âú¹ÙØiªÄg²¡g®IFñÐN!/°Ê;bíOàÉ½"ñó4Iõôa#óXV$'õ@Â±´y]¦<Ïüä'ÕÈW9lÅhõ£Scô¨»ÆQ©ù»²¾G\\ÜL»Åòy(È=MOÞ¹Í=JýV!¼%óy(ÈÍ6ÈýÑ]h­´f´FPY½÷e´)Á)´ä¤928SNÞ<Ou¿XÐã?TÔ>ÏnÎìÂOÔ¤·ÄßX?>DKfÜ~÷aþÎõ=@¡þÏù§$IbbX¢|t{LLÔæ%x¥E]r&Î¾Þ{QxÈÀhøæoéØçí×/ÁÛ^gÚ¾û=M¨È õÆoõàU	Ë=}Xçµ¡."/U\`ù"'òÓõ¡Èæ#ºß´xÆb¥#g©Ææ¢'(Ýùè+¿áEÁd$OÕ\`ÏHh'¥yèõ5ÛÞÉdû$1xè'"çÓÝ=@]áÃ´aiÑæ¡T|å¥þ9æ%ÅÓnýk½å"Nõève¨­ãø=@F¥äæÇÉ¿d¨íÁàûÝ gÚ×dûaà¿¤ùý\`ú¼½IVM\`ÞÓ8§;l})áB) ßõÔ[»¯Üèîé}ÑxGfâ~{ôË¿ÃÃãñä3ÿ4}8gÓ=Mñ¹Å<¾ãIÞ>ËF¤Ø=Mq¸Få¡ýù{oF	('%¡iû|®ã¸Ff¢ùÈ·½Ì´tÀÏÕØúXühâµu¯Yã~Ð~wV½ÊªV¡»!ó8|IÊl{£Æ~DQg¾j/Ó8cò§íT\\zdW¯ó}]f?ÚnNa»\`sj#Þ-§Âu|£àÄW§¾òe\`;-"çNj©*¤·ÀmÎûüÓ°ævØ+Ü»¥ò1QÓÉTKy¼ur½ÎÑ|-£Çj1q®'=MÜÁ^~dY¿Áý|äK½rNY£Ò¦øYOsÏ2£èFK÷ÁètGç1Ù¾ITÈxú?\`7kDýÇ»ÁjW36äôÃÜ3 CqMZHâgHà4ÿvÂè;GÄ%ª»ý\\ú	©/)÷}zâõ­]ÜYaXm¹©¸F8U¶yÚ.Oá¯g¯ÙfèVì,9K&NA¬Wñg=}VÁìTíS)KeíH.<¨°ôùÚ·2á7ÍVñôQfÚ8ã*5¯4Ú¢1­	ÀÚHòMñóA©´­çì,c<I	£ºK¡®'°iÆÉ½7|aifð¸®eç»üb)Tqsu¼=@wYetûü{ÓÂfkXPwºHu_g7=@Ø#Ò6ÑüÓÖfXUwÁu÷W]µ«_ÖÆyDK'O»L"rQÀsåÏ¦2#YxOG¾4õìüBÂ-¼òßÎ?¼Gã­Üµþd³½|üãþrJa¼\`rX©#ÎÆ´ÁXì+vãÌ^}¤Yß¼áõ×Î|cèRAº|ÚbUl»@ìØ½ÖôÇNTªä®ß÷Ú"BOA®öG&T±/¶{X)XÅ¥6 I=}ÚÌ£,u¸ß§íÂB#Â3uÆÚ0ÃKÁ­w÷E¿Åídð}HLÉ½'Ú«òfãTVèêô¹Hà\\¨Ì¦oà±ùKÂ¶¿µêx+oôßY!°-d$Æ¬çó>ã^Ö êÍB aØ*#¾7õÉi§\\uØ.EÈ9ÚMKá°_¸áÆJ)S1ê80{@ó6@gÚT.ò#0º»h¡Òãâ¥QhÜ\\ñkA!8i9x0¾dßôbîôf)¾Ó¬¿?âbí=M4UyðáSöðð>\`ñõ¶ÀÑ¼Ôà[Ò £Ë@äÆîd®/ÔçEPÛ¡§uÔÝá­.Äoç<(iÕá¥¹QázwÅ°Ý»	åÔ;ù°Û°x-þû+í¦N×. ¦þ_Ë¥f}hyzUð«Agw7uDôDÆÉÏ8D\`®·ÒÞz_p9eV}	\`Cî hÍ\`XcºT­Ü$]c±D©ZÀíze·ñæ"§zK°!eÔ@âÁGÑ¹Îh¤åµ£wöÆÈ÷ºÔ­7Dz'£a	ãAÎû¨%ø³ùÉeü"m1¡êAñ< ¯%ã8©UÀ:ØÞ©¯åAÉÄKée¾GÈfíÙ[CÈÁ©VúºÇRõõ%=@q)=M=MFÜs/â=MÅVîY²Éc­ÿ|º©7 ~h_ {ÈËRÖz-Ú6è¡(Ró­á®]ãBÉã<ãÞVÑz¾><éCfòí»ÁG¸¡Cô=JRµËv¸ÜC=JÒµËx¸äCêû@°\`Þ·Ë·F]qC$êûA°hë´îGF§]q	CðªVBð®Bð²ÖBð¶vîBðºV?¶SñTB¸ÛZFÙ8blëÆö·¬cÂU/ð[¡4ºX?öSñTÂ¸ãZFÙ*0bk+vê°,BëÃ,ÂªG/Zî+u4´-à>êB1ÖSªc8}*­FÚÒ*Pc}+¶êÔ,Âª/Zö+õ4Ä-à?êb1ÖUª£8ª-FâÊ*Qbm+¸=JtN°-¡L«mFâ>3Æê×r=JB1Øo,bY<bò«µ»ês8¶*¸=J.ÀuimÅ[¿Ø!ü_XgQÏ&®åhX¿qâu=}|§®å~iXß±ÁqâuOÏ =}|©2¡Ó©®åþìiX·1X·9X·AX·IX·QX·YX·aX·iX÷1X÷9X÷AX÷IX÷QX÷YX÷aX÷iXë-Xë1Xë5Xë9Xë=}XëAXëEXëIXëMXëQØª=JXëYXë]XëaXëeXëiX-X1X5X9X=}XAXEØêi=JXMXQXUXO$w!CËæ8çuz~P¿wz~QÿwÊàzÅÒþpUßÃx§ÊèzÉÒþqUÃ$xjklmnopqrstuvwxyjklmnopqrstuvwxyZjÚjZkÚkZlÚlZmÚmZnÚnZoÚoZpÚpZqÚqZrÚrZsÚsZtÚtZuÚuZvÚvZwÚwZxÚxZyÚybjâjbkâkblâlbmâmbnânboâobpâpbqâqbrârbsâsbtâtbuâ5Ñõ«®=M¤¨«%Þ0³ß«=@2çhÛ úDÌáQ|É÷ûY=@L½(³ß´=@Vç)WÍ_wIIÛ=@ûÄÑ¹É5wþñÖ¿Þ=MY=@|}#;W×ã$&³ßÂ=@§¨ïwàh)WÑ_±9Û=@ýÄÙí¹5yúu?ÞQ <}">¥7cd&´ç² NGèïo¥À8)YÍgwñ9ÛûÈÑ=M¹5yþu¿Þ"Q |}&>¥Wãd(´çÂ Géïw¥à¸)YÑgIîy¥èè¨2ª,§§;Þ,û6$$M3ÌSsúDnÁÊo²PûakÕ:÷ÌÙ©¬ÀKÄpI/×m^¹è¨4²L§§?Þ<ûv$$USÌÓúnáÊï²Pý¡kÕ;÷ÐÙ)¬ÀMÄx	I.×q^Éè©2ºl§©;ÞLû¶$(MsÌS'súÄn%ÁÊo³Pÿ!akÕ<÷Ô©¬ÀOÄ	I/×u^Ùè©4Â§©?Þ\\ûöüÚ&ªæo¹cZÑ'ÄQFÐ2±Ó¦ìÔ¹ÂQFÐ :8}%²hÊ <8}%3±Ói®íþiìYZÉÂð­Âð±ÂðµÂð¹Âð½ÂðÁÂðÅÂðÉÂ­Â±ÂµÂ¹Â½ÂÁÂÅÂÉÂ=J«Â=J­Â=J¯Â=J±Â=J³Â=JµÂ=J·Â=J¹i¬qì¬yì¬ì¬ì¬ì¬ì¬¡ì¬©ìì1ìì9ììAììIììQììYììaììiììqììù)ÙÖ'Ý´=M"í±«ôÏUÁW¶¿À·ezôò'|FÚ7ðê?ôúc+Ba=Jn\\aòÐX´DËr}=ME[bÇuvþB££&-&Æ=M³[»æ$ø!%e#§ü×íé´gV ÙF£èQØ{ù¡ïgþâæá"E£([1fYPÒÈ!ïD~iJP=@Ò$/ã Ë«QÎ\`lMÿr®°ÔI»4·éLßAHÒ¨p¤Mf|'¸x¢Ò$K×uü¥{-ÔÉ¼ßKnÜ n7Ó¨v=@ÀÒ[ÿÙó=}_Ò$cÅÌpéQþÚ1µD'ÌÖ§Û1~iS!°MÔ	¾¥qKÿ¹ôçO Â=}¥zÝ¯Ôé¿¥<übB3°?lRÃ5ßóK»d=@D^Õ«]°^o1ËpYë·|ßp²ýZQÇÀ1	¬ï ÿUTÝ=@4ª/ô:¬OÑØ8í¾±Tx¢þ1:Si¼mäËjI½j|4Aä8C\\¼0\\+9$ÃÝãÈJh»N±¢=Jf¡sJ¬&æ-%3NÎIpCó:zÍpN±vmµ¨O[Ì:D7H>yôò£Rú9Î¿ì¯k°àc:Ç/ÂxB	Î=M°j~gñ13úÖÁoòu¾+oã3q[÷:Â¡Z¤¬$yëhQ¸	+ç¯	:ñi-ß#·]ozÃâv,ÑõH±ð&ÒûH®ù°ú"½¼6T3U¼AKOSNÉf3I#¯\`"ñ:º||øìg»àü,3£9@J{*/óVÿz¾=JRÃÎÎöly¨QïÏBdÜ,IsN{6T=}óVqNIlt²LúÐÑÐnN1Ô]¹:£"qH)#=M¸ÉKÊµ?&³&6ýâðxoÒ¬f=JNÅÓ¶UxbÐM(p=JkG¨eÞ4-i =Mdà\`òï¹=}"½°mw¢>³Y±ð­UÛ"êCgFê¹}"½«m¢>ªÌ^o=}TaÍ>Ê2U´mþ_ÊhÄ8ÊPT¡Ê ~ÛËuIdlÓ@ÞîYTIotJLÔà{ïL	í{Ìøb8¯dhf/·æI¬@þúËª"áf¨M¨ì>ôýJ^Üô'1^Ûô*ÀêÖÖ_´ÿç(öX¸#èöb½cEÂ4]÷qëichkÍÆá	#CÆ²°Õ<w%¾Ûëö[Ø\\@C5¶Ñÿõ¶Ã)MYÓ!)IÏÅ!&6©Û¹¿x¾·Á¸Á¶A[tðÇßøMø MímáE·Ç9çHÞÐaîæ¿gçxÚ£l¡oÁÍßäßïû=@{¨f©Zþ&¡xm=M-×ÿ÷¸Àô ÔxqÑ=MKÝeÿ½s¨PhK&púõ¤	 +á«ûhzùË¸àô¸Ô¸àds¨ëó,¹=@vô¯î}÷ì ø¬(¶«ýå±wvXýÛâÓã²A Ö®V±×0Ù	§>=J´hüÁ©äÜãäÓÛËÍÖßÔïÖÛ!IBÚ8\`îhÙ£ûbA	½|½»ríy=@ãÎûþÝð[=MÝûu;õeÙî¶¦MM¢méBf¥¾ÙÒ=@!?åôy~7ùpVWM@¹¼=Må·_®½Év®ÈÃ©^ÊÂ¢÷ï1á\`9A³ªâÙéÅ®ëK»û[Û!ñQNPOC½½}"JwÄr|[©Ã)	`, new Uint8Array(89487));

  var HEAPU8;

  var wasmMemory, buffer;

  function updateGlobalBufferAndViews(b) {
   buffer = b;
   HEAPU8 = new Uint8Array(b);
  }

  function JS_cos(x) {
   return Math.cos(x);
  }

  function JS_exp(x) {
   return Math.exp(x);
  }

  function _emscripten_memcpy_big(dest, src, num) {
   HEAPU8.copyWithin(dest, src, src + num);
  }

  function abortOnCannotGrowMemory(requestedSize) {
   abort("OOM");
  }

  function _emscripten_resize_heap(requestedSize) {
   HEAPU8.length;
   abortOnCannotGrowMemory();
  }

  var asmLibraryArg = {
   "b": JS_cos,
   "a": JS_exp,
   "c": _emscripten_memcpy_big,
   "d": _emscripten_resize_heap
  };

  function initRuntime(asm) {
   asm["f"]();
  }

  var imports = {
   "a": asmLibraryArg
  };

  var _opus_frame_decoder_create, _malloc, _opus_frame_decode_float_deinterleaved, _opus_frame_decoder_destroy, _free;

  WebAssembly.instantiate(Module["wasm"], imports).then(function(output) {
   var asm = output.instance.exports;
   _opus_frame_decoder_create = asm["g"];
   _malloc = asm["h"];
   _opus_frame_decode_float_deinterleaved = asm["i"];
   _opus_frame_decoder_destroy = asm["j"];
   _free = asm["k"];
   wasmMemory = asm["e"];
   updateGlobalBufferAndViews(wasmMemory.buffer);
   initRuntime(asm);
   ready();
  });

  this.ready = new Promise(resolve => {
   ready = resolve;
  }).then(() => {
   this.HEAP = buffer;
   this._malloc = _malloc;
   this._free = _free;
   this._opus_frame_decoder_create = _opus_frame_decoder_create;
   this._opus_frame_decode_float_deinterleaved = _opus_frame_decode_float_deinterleaved;
   this._opus_frame_decoder_destroy = _opus_frame_decoder_destroy;
  });
  }}

  class OpusDecoder {
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

  class OpusDecoderWebWorker extends WASMAudioDecoderWorker {
    constructor(options) {
      super(options, OpusDecoder, EmscriptenWASM);
    }

    async decodeFrame(data) {
      return this._postToDecoder("decodeFrame", data);
    }

    async decodeFrames(data) {
      return this._postToDecoder("decodeFrames", data);
    }
  }

  exports.OpusDecoder = OpusDecoder;
  exports.OpusDecoderWebWorker = OpusDecoderWebWorker;

  Object.defineProperty(exports, '__esModule', { value: true });

}));
