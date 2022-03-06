(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports, require('web-worker')) :
  typeof define === 'function' && define.amd ? define(['exports', 'web-worker'], factory) :
  (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global["mpg123-decoder"] = {}, global.Worker));
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

  function out(text) {
   console.log(text);
  }

  function err(text) {
   console.error(text);
  }

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

  Module["wasm"] = WASMAudioDecoderCommon.inflateYencString(`ç7Æ§§c!ö½vPÃJh07ºjzÄntwø:l¢{k«ÿÉ@×d=}W=}l@á½Ãë.¶\`ùô]]R$"mÞÉ"ÜýñTº¶oÐ×VÅÔ|µÿoÜ		)äøg!v<ê×%êÆ©ç'Ù)©å¬a	$¸Z2¬ùìÐ¢TÆäSÜ	ú'.¦xäùóÅtNSP#Tywy3r?ywT¯´2racóÍÖfíçÅT ¯xCwv¯=}.xÞµÆLþÚù3ÕÃIôÅ¥TÓl§³ûï.þlÓÿ,-#Øh53ìÓÌ"÷kî¬¨¨©»éc¦Õ¯&|:%\`%§¥z!Ê<I24ÍBQßpgØÿkÝÝLEÒ^¤ëËÒ¡ÂÖ´ÍÊ@pkÞäD{9kÆn4­bÏòR8ÌÝ¤<±ÁEßNt$l/ïÏ|:ï¨íZ8ä,Ê3­tÚæ·ÙU²¬T¿íì7Eô¿ZÆ¸ÐÍtÇòy¦ûRÓÈ}5©c4ìûb@æe6¡0s"¸=J)8í¡01í¬5óDþá®kHPAC9!¯½¥qP(ïÈ éY¦y"Õ)¡®æñ¸ôUØÂ¤=MáDéÀ£e ¸·$Å	(à-¥±ØùèÙ¦"Q{~ÂÍ×û=@^baèOU¥£óyõÌYD÷ÛV=}}×Â}º0­ÕÜ|H¸ÏÏÁ.ÏëÒiÕÙ=@Æ)ßÐY2O$B×x­»}~¢j=@üâ|ÐÏfß[ÌprloØýù°ûVBÿ2{Lÿ&¼|ÎeÄ±t¿|¨Hkâhï3÷û_kDë«ÿ¦hÿõÒþ´üj=JÙ·C/âð 1ÕüZW­qÐÆòô¦p!és;{h\\ÄzpDDâ=@U´øíû%Q\`ïáQnY1ßu¬Js=MYåÌ~N¡LBõTªDc)àõäq¤t=M»µ8|uø»	þèDWNwpü-×gü¡Êÿí~D=Jr¨bÈÿÒg©¢Oc«/("Ä÷ßì"AõDèÔ£èØyeéØE=@òqhN	nÞ\`=JØªL«UÊõ?zRJ·Ë43A({Díy:D3rùj ÎÐB5@VµÔïz(Î>ÞÞâý>ËÛÄ§Ó/J(Ý{'ESç¼I9póÊvsÄÅ¿±	¿ÀôÍ=}qÜe=@óÅ£ÖxUðVpµ!öê bòz~×^Ë(äÙ÷Ô>o×R¶ctk]w¢Äß´w-¤¬BD ó0N7Ó_Uwõ3e<Jé°½=}>»ÿs½L6PÝ(Þ¾\`²À @Ó|Ù*ôIO9Ð1 yz£9)ûõTðÍ.¬ü(ÖÓ¬0H?îxå£ Î§É©©=@XÑî³¬ÔÏûÞfôÎ7iwÞ¼äQÝËÞ»\`sÄÊ?õü(¹åðÍ=}¬^KCª¡4dÆä«cZo*sÍÞqs/eÿ+eúÐU²w1×:|oXÑõ¢ÑDu:3ÓüPvvzGÿÕV·(3(ï>É9 CàV­9Ú¢õ«ìD2ÖàZOÈ¦® ë~=MÍ?hÜÎÖ%tcÎ9½¼>ë_Ï×JçBU¨d¦ÇÉÖöt8ØÖ]nQ­ûÖöVÔ?s½u}èN×®çÇErðß'Më¹]ÿy)¨JÖ<ÈÀ?óz;D*f¹Äãªóüû»7¡ÃéÀ/+ÇcÎ*t}ivKgõT~Wtð\` ó¿»mmâS=@8úß3òTÊ§ì(ÛW"1ì>öÀËá²wÊ(I2Ý§:ûRHËp.¦÷DÝLà¼°G	ÒyeVö"àû·ô5ÊÏæàÅ(ßU×æxñKTíúNóIoÃÄU·ÛÖGQÙ·åÆy¸á.§nÆÜQnsnfvm¡?ÍÄC~fÄ°s$^HÏhÅ{<$Ö¤ÐOÏ|õ4xmÆByM_þÅp«~OâÜªSD-eíÐÅ¨DægÍ£\\oåñª,s¤ ÞQ0#uþf|ré=@/#@LàcÆ÷!éSû§_¹&2#=M	Ýi2úIçiÍÆN­p.£dØkYÏk?Õ¼£¼o?ÅÃÃlüËîttT=}ÑÅÚ9ýüÎ(.&=@¿RWÝUJÁuÙZ1üßËòN²µ#jî5Úq¹ HÅúÁ­Sç½V·ñ¸ÌÑäå^TSF{süZÆþ.M=@Z,Qî?S½öÀÊLLÿEGnr*	ovøîÂBù+dÙg&½Eýº[yDGgºßh=M×_×(õÖÊ/[«;¸jÔîE÷¶piÝÃøòtÿ^À±÷gµcà*§s#Þ¨>8¬Úcvhç[®ÄM+Äÿc*¥!Ó³æ]óÔJÞê¼2j¾,É@¶ï3UÎ¥U°µt¡1#a®¦Eª¥¡jÝÍõåëXè[ÊzäÓÖCÃ²zð	°B®ær³CÚqJf*>Ö¯5£Ý1ð2BC}êþMNâz«?.wðîÃ¸óDÐ."¤èN9²Ø9P?3Ø.ÛpòljÈP¦âã?]ÿ°|yq÷°oSíóºS0nÎ®Ä¸^7ÉÒ]7uLÉlöDwò¸áÂòü àÎîqQ¢_¶HÃäØwGM·µèËwþðo¥'Ì¾Le³±ükÙ4õ¾ïÈèw@&d¯ÌWc$ÛÝMmeòx·D	ã¾ÖQCîÕ^LíµÕ¦{NÛs=@®WÁÃ.>áyÅ*zþßÄeÞ«WÝá}OÎi7m´@û\`6d:tìËËÍqQ²ÜeVÍk{&Ç¸?k]ïâÓ¿¢l'-#j5e¸[¡÷?T¤Ä·÷(tÑM¬SÐd0fÌÑóÎ^¾xN@S$]1 AÇüR Sb{Ú_ÕÕEî>=}4LTÑd?Æ6bÇ¬ÕË÷þÌð]G@yr·pRC[oz¯f<*n¢UrÏ'3éÂ-¬­hÌpÇ¹ÃÕëEÌçjú¿À c¢Ñ¶j²¢ÙË"pð~Åÿ×éïg½a°iHâÝë1 H³ROÜ :Òýß§ÆßB!{@»Ë+òe{µLoÒH:|S¸*ôãáJte9áêA7ê)Ì¥­Õn(àÔØqË]×qGWÔHß(?òw8kúÁGGuäç]¬YhÚÉÍs¢.v¢$ÍÆ\`ÂûÞ¶Ò/äÝDZSCNÏÓìGF¡þEV2:²F:ÜßéOqlhNPdRÄôI(zWV­G ¶9Ñ)¦¯=Mu"¹N5Òn®^¦ÔÍBøóì8xR~o2Ñl]õ÷t¡ RÕhø)ú$NÌçíÇ#é kQúÄ3T Ga ]dN7ôMjjÁ/ÞÑ5(H¼ÛÞ[CoëO°v2%kº;¿nð£þCØ§\`6 ÁzeFòd¶â2x;ßÇ¡æ¥©e^7F­.Kh\`ªl>ÜEÙã1â2äýoqöLô ìK!¡¹Ð¥±àÝá	°ÕµÌþ2C®¢¾ÑTafd1ÆÎqo|álxr¢gÄËÓõmíÇ¼²|}¿à	=}½ìl°íÃ¨r:å=MEid£ù¹G0ñ¿©yc¾°pXS)ïE"W±9ÓM9½ÁÙ'ø³»Iæ$àÁéÎ!ó!ö	¢úmÉxØ8ML¯G=@(yí¾%yI¦ùI&h¡©%5)kHßÙ%×Ièç÷èeàF Y)9	íSLbn	¸^GQäDföÆÚm"b"ý¹¨&IRíõ¬¤µà&Y\\ilòé±Ä-°pifá%tpghÎ|(÷9h[âã'à©ÔùAYÌ­­8ÑÏm÷«­àOã¯}3¨Úzº ä¹*Õõ	bHÕNôyfø¸@ÙVô9HÌ¬¯á'{¿}=}\`y®ôML¢ÒGÒTGI=@ßê'LgF©½»×·\`YX!î+öö#·4&±»XÊôÜë®½ÅW0ó©O=MS¡ûÖ#ùìcG¹äàá2)å½«BtûòÏ¡CyÊÊ·YÇÚ¸SèÉcC&Ö :Á\\rbÂÎJ½òBÁ2KÀM=@;¢c v$Ö¼N¦íC.Ò¸G=J]=JmeàÃCt^fl¯G+QIâ*8{4ø¸ã÷2eno÷²2[Dß¹úà¤eÜ4g7¢KÌÆj2±±Fîk=MLÊ+¯ÅN <¤rÏïóY¿/ÍåbTâmôÚá°:ç_¯|×bð°®ß"þ À¶|!àÞðç×B×\`ìÐàá7EÍ7·ûïðÝ¥åSWdÐ'Ààknvrº3Blm5ú±ãZ½Ò_Ürrñòäælá3m57¡.Ws¥]^»¡çëÂ@~u+wv«ÑE9+D;e¨Z!i;âë\`=}:¢Ö¡ÚWº½ç¬µQ~´Û|ÁP"ûÊ'cÆiÕN#GáÏGöQ¬¿	W¼O®#=JÚ XsAv£¨ØHøÉ_À±kzGgdñ8Q©QFÑÑ0¬_ðsf ©ðé*¾0uqôE°®TC°ÉF4mâqÄ\\DÄY×´xþÊ+º¯B{VÇi³x»¯ÝÅ²Ç{µüÖW«Ý]$±RGã=Jøi=}FOäÛÞæQpû$ß=M¡Ò=}\\ÝmÝq?Æ±×¼ÁM¯IÊo=}&[¨®mjC,d]ÍÊÏî¹â]8l¤dê¿?lFxÌcæÇEÿ¶ üE,GçÛØ¸Ð¯Ñ¡ÿZDçÍéGíç£À{ST}²(r,Æq¼î¼¾7Ý"ô\\Za"[v<EI9{»RÐËØþIïÕBÇ/»ÈV¤æQlq³Ón{ìYÕ°Ýd7}.cùzåZ.\\'¹5HÑó-qÊµôr4áãóúºÖÅLbn((pàz«W»Îáusyü´ú6ÆÃ=@6G×Sä;3ÐX!Ûïc\\å³Eâodsoy¸w»gV\\xRE:.|¶ I7þ;¬po°aôqÜòµùC®\\Ý}ÖsÁ;t UÈZãGÒJÕ¸cT³¥B,^àÍI&ÍÉ­6$±X¨÷7ºú:u(=MU9'çÝhnÄ¨ ØÝh©'jÅ{ûàiB(=JÛ	£õhì%'ÑÈg$©v(õ¬¹ÓE±iÇÖÑXÒ±ËfâlfÜ½QQÙHú³¢i1ûým¶Qi´ÌLB[íÈ´AÝÏJãn7àTÊãnÅ©m^Áè¯h®5drÔ«­<Û|®GM¶Ê\`ËÿsË»I4Tf.}þÿPç¦©X${ÈÀôßÔ@òUÕèQßþßz¿MéÆ=@,eZx+µÚòVÍçå¥E¨A+6ÌLg_ nò|²Pk´d0L¨ç3AÎã­¢ä;Qq"{c@=}¸?&ÜFù Ù=M¦Xq&CîHz&4¤­¨îÄ|òÇð=}üÃáaS|ÒÚE¦TU¡K¿çD~J>_æn=MÃÂ¡MÐÆâÙõ²ZÚÞ=M¾m¤:¾&pMæº}jDÆA¯Éð=MüvêâGfXøäÜò@5ªâ¶ñäVÃóÔÅKV=@ÕñÄÖ[½\`m4´¹ñv=@áCÌól±:ùùøÄóÜC´¹×?XÜ³ÖºqMEÆó°\`-Ü¯=@ÜÝRUÜÅOQb9øLåý?]r)]C)¡¸à;à\\h½WÜ¼dãpwÒ°lh.íÔ,°R}*üîÃv³\`uë*Þ©p6£AºÖê,ÀØ,+­]CïNÅÏªºÈF_=MIS3ÞÝYäÁÁ¹ãÁ_#ÍÆ¦çæV©çæf©úçÖ÷É&¥	¡YÕyãÒCã¦èÉX-îÝüèPiÝ«ãæClôÝ#aò=J (vàX§s¨ìö<×ÄóÉSüãç®FÝ#ýXÊ_ÁZ]½b½79P$MÃsS¦­ÎÖS_ÙÂº¤ü¾4XLU´HÎY¥|ôó§\`ÏÚ¾=@öÀ÷Ùv=MÌÇýRß¹Å#rïýÔÎí\`Å7UbÇÅFwÝT7;®×ÛÚäl)V)MøØÜú$üËãÖÀsÿjÃsgfÅã,¢À);5OùÇs=}TÝv°ðvõ¡A©ÿC.Ôã/²nññ#ÊÇ@ÛSëÕ7¾ÔµUÔ°±¯³ñ¢¤Vì\\-]Á¿;ºèÀSÍÜà´¯½Øw1ü7twøÝÚß|Ðÿ=JOÊh]õ&Äý¤¬÷ÞEÖÚ¹Å"B9{©í-\`jj\\SÇ-Ç¯³ðbUg©\`WÝêý,ÒðÌ@JY1ºÌ9Íy1£Õ¡~¦e>Iiñ±¾,RééÍ¨Õ.¨ËL\`â´aÂx§&áÆúÁè¶ÓÓz¦p$2o=}¾ÒÍ»§æ»¹ÐU/¤ôjkooë ~îï<=MÚÚSZ¥þcÞÌørüRuZG|Â¸ gI:«TÊ{JâÏ²vîL2zq:}³®[dtÙ¼YWtèÀ9ic5áuØSÎ=}ÓU#|5½tùÚ:vc§ÓKÑ¯¼9Ò; 7IèûFúOÁÖ>/­ãóWv~=MälÏee§oª#Êt¾æ­9íRjìÆÌjÏ"Ø=JÜo¥·8ÍÌÜpLJá=}hñnÇx»Wu©àT!X/óÑÉµ¥ùØóQmÖÎ\\ÑÈZ¹ïÃ'ûYu^Ób3×·hëZ­y´S ¼ ÒnAÁwí«9^¦°CV­Ç=@pt7Ãhn¦åN\\T±½Kó=MÐEºûGÐÔ¥·=}=@Ô¥ÔN¦B¸skßC}BúLbÆz-=}¿ðDán28>Dñ=MríÃî¸kï5Ùm83ÉRWHÅM²îúÚ-¼þ4ëgz¶¥ÎÓÛE[|»ÑÄ±=M<Ìú´¢#vêÿqlóVFd3Ø¾r­ÊÏUÌï¤=}!;HVèýê(¬¥K?=MaEÆø+éN^k+¸¸Ô ¨7(I(_x¬ØÌ¬7P|¼ªö¿åqòÃVí×ä-eäÞåþs=@ÙÂÑ!z'JÉÆá-råýJÌHÞI­Lßb=@ÔQZ_FÈ^@~S)ÙQy(ú$"%UñYa·FÈé8PV1´È¤«S£÷TÇó¬õ#Ñ\`ø9Óyk¿¹ö EÉ&ÕX%yh¢8¦uA:!ó1áhÆy	^(2wÒ÷ø|³ùgV#¸äÏ@7åÍ,i Ûpt#=J#w¡êEYëÙû	I"ÈÛêô#É¦%énn!Äªí·Ä\\ex«C2¾¦hFÿùþ¥.THÔVE,Å¤Á±=}=JÜHdÍ=MUGÜð»LgXU ¹Ô¼¡qÍ¹Ú½=@ÏoK^*ÅAeøÆn¯D_Z!	M	§íÕXå?eÖõôI%_g Ã¡fËñ±iÞõ6GÇ0+j¿p?,¨PÃÇO/ß:û<À¥§þ9¡å¡é ä÷¥à*õé)ü)=JF¥¾7úìJ:üádÕ¾q­ ÷ÐÝÝ3|gWPÅ®DS\\Æ½H=JV*ZY\\z°wñ¥uv øçO7~ÛUÜuiã#¿]üèÄ'£"87r%\`Õ!¥0¦¿¥QÞ®¥Ýé*D¾O&CÇH=}ÅeÄN¥¬Ûg¼ä~KcX1[ÙüüXËÄüÈvþâíðo¹¤¤¬lzèåW×¶i\\ÕX¿Êßµ¤¤¼­{ ÎØ,áF¦yz/m4a,mW²'QCÞ'¡_9ôãõ¤($i)\`í¥í))è÷fÆ¦ò°(f×ÄvçÓ?_iMþëº÷<ÐlÒkÁüIl9Àu·l9xB,»×[J¿¥x¶0DYMy¾3M?dL©NC¹L[HÏá:¡vC=M{?û,OaSÐnÙdÌòå:M°ÍWZeð8ÿ¸h\\ñq¼cú~A¬î[ «¼þàïÊs{÷Ns=@Û«Dæ4½N°aÅ) U}À2å´'®½MÅ" WðºÐ2¥îÑ5ûçk}z±èVl.ÐYfè|ÕòáØyÉ;zhjSz8½p>|8Ó»,ß¿KvÑËãö³A^<ZbST¤Ëëé¸ïq7^éGFQãÒ}+±òªÃ'DÑÌ1y Û\\EEäv-ñ²ÊJ=}.áý¬mÇø^BSÂÍüJ|¿a%ÀøFý=}à<v,¶Q5=}þ5Zpï^vx[w¯ÂØÇZÓÓöïú\\|t|DWBñZÕ¿zÙTçÇ/dT¼dÔ<´oç´Lç¤®\\<©|Ù\\ÎÒ×\\Q>TÈ=}úGª{ö¿ãÜ}ÃüWQ»_çi=}µd´Ò	=@;=@ßÐå"·Bï¦\${Í&^ãvÅVÆõï¼¢GäoÂ3ºS=}$r{}L»þÍÞ­3=}µcËw§Ti(ç¼2¢~axðpPûH{V-t¤\\+ò[,oâ\`sYzlÌuÑmã¢GtýÛÞ=@uÎ*Ü±ûßx=Mv¤,÷¤St<PgD®;mo=@Ç®ÑxJ¡Úc+Óö³ºc+I ¾ck|aQìý÷³8¿e}Í6l§ì³µfxÖd_t{1M=}Kã=}³Æ&V:ÜjÏ3¥?UjÔ-óËSqßlÌúÈ+Ñ½ó=@®{nÛuðm^ÐÖÖ\`º;ZØÌ%Ò°FZÒÜÂ~QYpKpo¬Õ·òP¿<ÃtÚ²ë.|þ}Âs§B5òåvõxOTsT1ðy¿Õ²_Ô¤rÐÓÍ­ë6Ù6*ï[M×õ	ow¢±=Jâ=Mv¿Tr8Wï·û_:Åp÷ÍZvkúþXcJÏg\`²çýÈ[â)RïµÄ"nwÀ<Î?çÇBlÅ[=@ïõÆMtÈY[ð;ãJòÃ¨örìp­¦oäõÞpõ#cV^=M¿^Û3¢¶è½Ü¯ßõÊ4bìk²ô"°Ûæµîtô²èzÂOÀñ|¹ÎÞò=MDµàt=@*}<®k_~J@=JëP~w¥)ÚÎÇó¾lOZöT¬DwÜúÁßùÉLvUWüV¼¤¨Hêøw?2êêtH^Ï+uÓÞ=@\\õîãxB¥d@:¶õúúÞøÍ±þ\\(ð ]ç¸á´»Î²]çÂ-eëjwÿñ2ÊCúV¿÷é²AFñM~ïxÏ§Áäw],¾>äð:{ñrîØ¿Ï·}ôoW¬8ÌÄKèjôµ»øæµ+MPá«yÓ/kÕPà=@ªô=@ùúÉm¡Õi$_à=@S´sÁÁF÷¹§PþÔPr_3×Çß¦ãàÚ~Î¬ÙWáÁ\`¸Ðö½:CH/{´áDË ã»6?ÎÆ¬v÷Øü÷'TU²ª·ï"Õp¡¨GÀSwÙ´\\×§x )¦Dß« 5=Mà¸íÉj»XqÃiH¶ÞtU&éÈ?ç¿ÈÈÈ??§n¢ï´$´ï´¼;<Ë¤ÒÑÝLkDN(bý5à0*÷;Ê¹o:VA\\Ós{DX°óÚÀ=JHz5IUµ¹%k7Î½ÑíÊ[¦Jg6ÛR=}úKÉ°æÀ ûù*¾-]E7ü§,iG16¢_ÏÆÑ0¹Ò±¸iÇvabü¥Mu:ï>=@7I7µ]¯­9þ[Ä°CªNDÄáÏgôR²QaÊ³Akÿb=J=JrpÐìJTªN8×tE¤ÂZX=}ìºÀRè[MYÞ}ðnGfGÅ7ZjDÄ] FùÑÅ@>¼)dÌ21¡9QöÕ«ÞöÄ¾ÂDªO7ºÚäH( GÌnÇ³ÅéÊ3Ú7­?U.cÐÝÎ*ÏX+rX[Z­%êdßPé=@8þD|åÑkÙáwHóÅ3B{àÝdÎ» *º+áBÌôD=JD³tì[~uêdJ¾´h[ìôz%Àè°BF«ÄÂë:Ò¦ýT:³Ù­ïØkÅ1-1ÔLBH­»¦Öl/PþOOhI>ùB¨zñª¯7øveÉ@³¹JwæèÜÕåÐDÎäü?>rYÜÜ´ñ tDîP2<9W3äõ\\PN#ÎMüIfòz[DßF;üûNÏ¯Ì]ìpÿ>W>0è°ßäÌ7Q8LR»ç{ÿÔ-è¡|¥ú×NXÐÏä¶j¦¼ Ãláä8¢=}^¬ø»îÓÅXîj'¼¤w+²\`Z<{L¸¿ÀRW<ÄÄ2ò{Ý1§2Åg{)~-E¯Æä»¨=J¡æbEàÛùéíY¦=}Sã=}ëèz å±-~aÂ8RsËûF µy_Ù¥ËFC"zË&½)L¯8¦üRdÑ=J2èloù³ês¤²¦´ºr«ÍHA|êFg 2{ú?ö%aW¢*WRÇs¿VHõ±+óÒÇaÍ­$§ Î½úHîÄníÖºÜ~cÉ±¡ö3¸û±áàÍ~C.Ð­÷ý!¯DÿùN³ae;¸ËYcÒ4ôÑLôÞ~ÙBY×bX3&~ÝN¦û°h¤èÇ´_U4ß@ÇÿÆC3Q­j} Ýp[Øy5{­¼kSG<8j¸KQ×æÐàã¾*jÏldÛë_ëE WQ_Å£õ3j©H§bEf­É>Þ[uh½ß=}¨8³sÀøè-L\\ÿöGpü>féq&dyGÑöË¯dê.-7>æ=@î_égÞµÚÖZ(µëìçá³«ð³üð5"Ä^oäpSÏ¾Xåw½Øø #¾58¼Û²Øë®±tMy/ZPXh"Q=MøÐÑ àl¢Ë=@¬õµìoßo=JÚ~@ÔkF]üÂ²zþª©ËµÊrQðÁ®+LGÎòî\\LR>9ÔSb|zÑ;P¶½ÿÝP6xØ¬ôó*'S3§A7L¬JË·kCÿbr\`iÝÛíaü¹Ùí©AZ1*ÒämÃQ@eø3û°>Á$Å¦3³ã~òðdübÇÇ7ß4ÜÂ#õ®ogã_D¾¸¢$_²N!ïÙkîJÃËW7ô*ðÉ¿[wo]]òI¥ûdÁ=@v¥=M-C\\ºl7?fù4³^.³áË\\ýõþU÷×t±LÃ°i^D=@ øóÖÈg»Ë6	dDp3|#Ã¬ÒáTÑ=JkÅ·khùóëðkËûoº=@:,s°£Oâÿ=M@Ðòmú¡F&´{û]à¢ÊS^t#03B7B²}{(8°ñEê±³x°ÃÇoåA¾QãD°oo¸Ã>S³ó=Jb@0³øPøn÷ÒÑð±hªHÐùJiÕÚòvyD°÷&1J®ÕN %!æÿ>ÈÎ®x_Ñ±DªÈ%ÓiÛ®¶xFï"ßûí!r:e¸èºýéöIJ·xS¿Ú1+áÃ ¿\`O4!rD=M_VøyòåÛyu#LøsCÐ¯NrÓ£àìÃÐZGÑ·cWRÈÑ»ªÑ±jQcÝ®'«Ü¶qpEîýõÍÏ£¶·¥ð«5£úÿ0²Ãp°þ¼¨F²H;¨ÆÉ@B­|Ô=MÙì±SH%é¯²KJ5û Qý÷vÏÓYHDôÍ´3G9=@Ïý[Ç,õd9_á³}Þ;Ì½O.#ÝtÜù0é;Ã5½8äP/°_ÀtRãÝ¨E~0Ôü´ °úLá÷¬hæ7?·%´O0]\\"¥æºÈÜ¢¡È·ûAäÂªD^\\7)Pë!=}þBtGÎÎÈ}e5ßÄ=MêËôÕ°yPQGG&´÷Â ,¼L%ÌÅµÀ+ÍjÑÚS!ôm\`h i0ík(-9vy[É´=}×ÆEGæQ>Ùº8O²¥wÝCÜ§ ©Hvù¾ÁÞ£¥;£ÂíÐVÚ[$²eî>VEÕô·«~¼oRð£¶Âô	É³ÜÆpî£SÊ\\qvÑÆ=MéEl¾V ê:àáyº+\\:üRÇìTræ^óµL·}}etYGS¹P8þm´£aù&(ñ¶géü¹¦ì§y!#¹%¢óòqò³°yÙè§ÆµeöW1íe«x¡zÖê87hªEbHÐ_5iTÒÐ%êäæÖ·È'}i/¸';XÊ¾Æ:u=M7Y4hf¤JfÛÃ&=}D³­yN5F¾¤ªL;Û)3m¶:e!ì2ý½ø2W)q>DF=J6êkéÈÍñã@´÷Â7»]é)iÃW®~ÑC¹©G¶RÑz#Ü¡2£m*±XÍóVX$ýB¯¯±2ÄìàJ\`Ëu(_PâtÈÐ	Á~&ÙOÿû¦e¦OdFQÜn±oºQ¨j6Ëè«^¼@ÊÛ09å0Årµt9(ã·©8ÉæÛvE"J±&ÊÀsnGPhâAøÚw±°-ÛÏÃiZnTõAÁßê°HÍgÊ=}Eß ¸#/*]6Õröl=@e;/*«Õoxæ[L­	3*ñDñ\\<5|ì£pÉXO©½¼×Ë¼Ðz¦ûääé#ÛØ¼1X\`OE(/c»FwÂ1/1¾=}B£*_xlÅÌ7÷µchj=J"*£møJzóX­ÙI'EEó°ºoóaôÛ©vÎ*ÐPÓæØÂu=J¿3l½Ý/}Æ.@Î@ÅN"ÇÜH7¬¯~ìMdßu*^æ}:4®®¾ÛßOâõ!¢Ëç³lÅ=J{o!¼[?¦kã\\Z8WNxýIò[¶ýQ|\\¿CÝzQ=}XrÅb^;êk¸3ÇØ¬ÛBýW|ðëät=@¨9·a¯=Jò·:Ð°ØËwO>k¾õc<ë$[QAÊ]M­bdÃhÅkÎZ5ÏãÀRíÊmAÛêÁ½µ¶¬ýYÝåÁÝÈáZ]?«ÃÐðÖEÃt(<¡P,3´òã´'äêðlè´ìº{=JÚ{ßÜÀr­=@í}9fc¨ØIhü>Òs*&=}d¨Ûç*7´áàX|ØUe/¨Q.·¤\`ä T¥×OÄeqjÉîW÷4¼v­oõöäPÄev(m/1 Û®¢ýFX÷I°ýêk}+ªõÂâÊ­/Áo²  ªª½K"PÑ	w1YA,í1íÚßê¼ÂS¿êzÜüÛÖÔÂçõúP=}aÓlÚtöñûLw8\\|Â_ÐegVâqrU³³È·ê± l<þÅY¾ÆÂô[ñ ÁÃøæl¾ùïÔê«ád=MWØð´öý«øFeò³¯ÝëàË£ÉÖõ¦0#aÑ &d²SK0Æ°$Üç;)do\`àçõ0qWJ±ÔdZxNüTÈç|æ{ºü¼æPÔKi@Û!Ë*RTËÍËmÕRðL¹"ebJUèî_¼X_sñ;ÀÔÇÕÆ½Ã\\ÇÿütÇä:A´c~þ¨Ò©í¼$aå$aâ¸aFµ[È>v8Hbµ*ê¢Á1ZTTd+	]PÂÈ¸ðõò7îrÓÍY³¢°«ÒÜCÛZBéåï«Üí«Ü3RUbÏì=J"x±ìû½\\òÉ×.ØÎ¥bLK0¤ÆMñò(¸î:WoóíÀ·©Ã~+9O<ðÅ=}D?[ÀAü<.¸¦oÇê3  ÆrÐ÷WzÒÀá5Q-µo½ÂÍz²]º¸ç=@s,ýN[÷¯þÐ<Üó¼ÃðÝMLäÇ·CÚ þNüòtádýÁáIxw lSVeÿ0(¦óÓ²ÎCÐóã«ÖÊtôj$D<SòèS#=MÒdÿt2øÉyQÔ¬ßKà"<y»çuGlÄñÏ8K0h¹mòÈodéxÄý%y2å=J:ÜÝLó^GÕýÍÙàoXs¤Éñc;ouÇrqIá¹í5#çEò]?	ý@üÛ:M©·Çæµ~4a\`7±h@[ fc4Y33ñó+ù>¼e4Ûô¤:óÓÈ9=Jøø#8¤=J9é%IºVJ}ÆV@oÝÙ)m¾ÊøõØÎ®&ÃWMþçGFrS9WlÅþá#[îÏ¶CõÄÑO%»	ìyò·Ñ÷ÌæñùºAßï£¹ÉÄ!«]¯ß»)+õY|o åWåãø5qF}L¶±lv±~´ÆòË¸#kVóîn{Iò<AZñþØJó|2ÈjÝPJz ¯1jÄò$qè'~Úa½¹dV»dpò)ÇÏó=@Ô>w[?þÍÎr34Ý	æPèÓw¿ÃØ=JA¾}%QQúkÖY7ýj¼ÕÓ¸ÑM¾bµùk¦¢@Ã5ùK&X¦Ã¦à$²\`³§¡dòQÀùfÛíkÑã:ÏSf1Çxà«ËV=Jîª·è­ñLf¥Tí#Æº!úú&¥ÈéÊ}\`ù¬è=@oíuÆ=}øAñò*¸4s%^^Í¢\`÷·Q*Ùäoäô¨1üÝÎä«*²~Bjb¹ÈD,Ë§Ù~ñØ	ÒHîß¼I;¿»8qXäõ¦m_lq¾"Ë¤EpóÜbU=J	þSm»fYö|õûfXs÷ÁßËÍÖÅB gTUîÕR÷^>ÑødÑmzQ~À5îªk1aôÛS·s³NTÉ¬îRZÆR7|"è²a8^9Vsn>=}MöãnúJ«Éj©û=JZüÔ;'ÐçÖ¯bß½P#=MÙR£yh}=J2¸Û~¶çÂøåÞætÐ&d8@1¿ÐOðF4¥ãÁaöqNaË\\Ð|¸à­¼qjºôÃp7¹%5A|õ~Ónô¸=MóT~=}Y§	lËû{ñ÷9'ÆçÈÇðÍý\`sÆ¡=@õt|à­K±GL=JuýfpÛá¦¼n8ÚþkÇÀ^Ibû¦ÑbÑ©rVGéýÞ^#÷ýkFáwéûK´òûmÂ6ãOôG7û,=J¼Õo8f,ÒbïÃÀÆûúoÿs¼1ÌbÆêÓbÐññy=M_5NÍò$=}*cç:GíË¼ëÐ83ï*=MmlO=}Odï#%u ¨ñà5ØÎs·h (\\¸)¶=}~§@ô<Z=@@Su#=M#±³«'ÚcQ\\È¸4tKHf§ä$hÐ$b(YÔ9	{um=MåÍhûMãå1¥Þ¢Ù!\\Ë9¥v5Y¥dZÞßàÔ|Ý&¼=M¹,îÕxQº¸Ü¤³"Ã¿,8$Ö\\!=}(«pÛ:ÿô»8xiþ«9ÚødÈ(3ÿÅÏÕ/TzÛ5ßæ4NÑÇ>s¹»ý4 ¸~:Aß>¹=}hö6<3¯¸ÕÑ¾LÉ×ÇíaåÜq÷ðò*½iAx+v80^=J&®jÆñ+odÄÒ:#ËÁÁæ°íÚ¢64âVr.÷1T=Mã÷!2%©ypÐÖ?VLEÝ#Þµ\\=MU6íRsè"¡·ã¦!»ë]KÏÝª°'ÌÊÿ44>ÞäÂ3²ÖÛàâ@b!b1ÖôgÙÓÃ³«ì¯$én ^_5ubp>O}_êY¶ê<^V«D/=}ëOj;ÙBSdzÊÜlâU©ÄóÍëv\\¤Fo½¾e0ÑæOÝÅ=@Q@üçì8µGådí_ü8	<j](Ñ@àë?À¼kHÖ¢4·»åUx@	ÖH£ÒSeõ£Û§ôª	hÑá|hZ|n*î¢§N\`' 4øð²øzP<×µÔâÒÐCß%Ò¾x¦ZÝIßíoÃ±¤vð§þ÷Xt@l¦×_ÅI/t{¶\`ÍIåµüÇÙ÷Íà¾|ËÓ¬2G'í|æÿÑAËAWÙ¹ãèR=@Ì$×pIßå*ðÌX\`b§þ_o=}VÔ×{eµ°þd=}Io¡þsI¯óæTW>9C6±_m7æ¡%QÜ[4¨îi\`£ùî»FC\`z1/¯Öîu¾w0æS½ÕLþmx#ªZAh»"Gªqís/ø\\M6öoÀ²M=Meûm.NóIµrþLG5}eÃÆÂJPñÆ=}åh	­Û]¯ihY«Óóï¢¡<<Q+ûÓë¢ ¤=J°|9RcOëKôòþÐBé­xYÜçkÆÌúW»r-Òè~-G"¥þ<zãÓÂR}Y­hNh¼Pô©æ¢#²/Í§ûçI³ Y¡K±>¼©,-§:5æáªCí§ì]Àè¢¶:2lëlð&jñå®o±Ö^ÊáîffW¯Íå7v½è0#ÊUwÔ¨kÓ¨Q2¬çÅy	Å%Ðmãëé)Ñ\`-þ^½Cb¶W·*³=J_¸P}ýî¦PkÅtHÕ±ç¥ç­¯àu¯ü¬0KQElUeÊ:Ì8I®?bJd	Y|m^9¤M=}KÝpÄìhú¿3ãså[³  ¶­DàñÇ=}ÂH·=J×ë³¡ã[Ùà¥½ì3¸}3 fû ¥ø_q(O1Óùß÷f¹ÊÔV&ÿ=J8-JÏÿ»¹»[¿L­c»ÈÜãwëF:Ç³ì×²k¦Æ¢HÅï'|ëdA\`¾ûååH¤4E@fò@}XÛãçÅøÍ³î4Å0ÓïLéH	^Gn\`Ádqo\`4A}«cqü:öüjE»P§9Ê\`ú/]|»½NÌºØ¹à=MvããlÛ<Ñ$úîÊíBBXM{;{ÑUÐæ=@âK{R^Ëõïæôú3:bÉ¶²Ò|U¿AÙ]QYRíä(=@&ªÐÍË¾èûÌæ»_ó´ª»5+c;M  9?ÕAÛ0y[ÿlIíÁ¯âú¤^øP;P¤²S$Gæøä÷àèÑ÷ççÍOê¨ÔþHÄYylâ¸xªÖKpÍãpo?.;×@G¥!exÖ¥KæÄªzuÃþVÊÈ¥ruâ!àµIåF¹üWØ	óÍô%>Æ§Ò	o¼@ñ=}¬u=MãbÄûÏÞx´¶ÏØ3?§ÁFot eæ»&^Z?³ìÙÁÉdóã[Rbu5¥áK	v~áë{» <0è<]>ïmÕ[bðöL¸¡ùÞÖUËKG4'PñCLë>'Bx,ñw².àîº|GmÛ:5|ánã|Ó ÒÁX=}Bòb­ÅÌÛï\`Ï$|#¨Ç¥ÏúÿºKDpÆ38SïbËmKéðø^ã8#s¨7KMÀ=MÉÜÇ\`´àg¡q¢X÷ytW6¤J^udÔ\`Ýir]Ê¬³±.÷8Óê¨%â»ÔÑGª1÷ì­ÞÐp¯wa=@^æ×$eÁ·åÇÅXÎÜÎ\`ê¡{-M3eò+x+Z¼²È=M¯f(óñw¿1MlÚHÙG1>]W?ÞN ë¶ñAÊøÌrÎ¿¦þrÚýÍÉð/K1S¶Bp"ÍxÂBÐ}Çûùô4øÚäK4­unQA®ÐÖ1X2UÜÝ.$ûVgNT=}kòì@gÆýÙ ¼Ñuêö[÷EìÌÍßÑÕ9£I·A_}pEðëÌW0»-îä¯¼×^ac~QÊsÑÕ[ö,n]õ¿Kò¿/\\O=MïçZ¾¸öð¤¸}]^îQ·Ál·=@Q&f§_dºR½þáW5½Â:7©òãYw4§\\KîÕ_"\\Àd1¢á©[±ÜkW}"	]±ÂDüõZUÔIÞwX$pð)ýÐ¯4d<ä®2Þ®$uÒoWKÙ,ØOþ!LÀºw7Xr=@òê4h§ÂhtÈQ#¾9ÉK­¨û.hw}$Á\`¯ªow»Øt)\`ïÀ.v=}>¾dÚeé)­»#öcUgµì¤ÀÛ4p¼ß²0yýºÐVß@×a?³YÒ9@ tcÑÖdW\`#Ë'?Í11µðúö¹	yiÛK)Q½vÁ©LG²N!Üw%5þþ>è¤_:þ¨/ò®ü­ÍÇ5éÄ9öyÚ!ÚöÞy@åFd¢ëÞ½?åªc%iAD¼~vA^·8YW-ÌûxR3\\ì=MËD®ÊMúC Sûàqón-mÊççÊ>æ¾<ÉÕ|_Å+sÖ}ÝÜ9BDß§êêî*/Ú¤)CÛ$ißµ$ù^ÄuÑ5+µÐµçÅX÷A_{vA8£ËLÉÇëºÿ«ßÅÑÍ$)ò@Þ;z'Þ2Ò¨.~¡2ÒÂ\\HÕNY4'VÇÄFÉæ*¤h±Ïèâm2þKÄùØmÔù	K÷©±Z~îµpîoyZ±x±¶/Âmð-Ä-Gë¯pF¿<®=@ì¼Ø\\oUXÂ>¤ê²	¡ew·èÞx]bÜ¿ï¯Í$W=M¢ ôO¿ríæÍHýLTå£Ï[6ã*$¼ü÷Oö5~z¾>4;ï±¼_«Ñ³gìp* ¬èÄFnoúÍj±ø­¦]Ñ&$i=J	÷ÇÈÝ¾ñÔ¦CUØÌÀ_\`2e+f7° å4q>? W®i<øbù'¨ï{'ó§È|ÆWNpx0Æg-×±¬W¤yèuN»VäRB}8%=J$g§ô¨ßg\\{iÀAö?ô£G/±ÄèæPß_Õµhê¸ðó)°´ÇZ¿dTeÂKY®¬sp@ï¼ïZÔà,PC@ZËþZ frZ°QøìÝ7}Í'¼ù~L!Xe´ºÁö×-éýM;ëOf¾}w1¹î¥X	Ã X¥Utfß7køI<KÇ£>zá¹¬N¨>¤øf4gGWp±òb=MRrÐ7¿ye]¬«û+#¯=J¾|+Ñ^lfÆ°Ýå-xÃBÆó¹+Q®Öë! A=@çBøAi­ÀöøCþcÕ¢0Ã¨ð$sê#=}Åª}ðRÒG Ø)õ{íÜ)z­FúbðÜFOPRÉs_Å¹½é²íîæÃ3<1=}©°@Tkï	#OðÔ\`Wd OIìeº²ÑËÇü½¦|*Ö!q9e½³Ú\`e¸û&î¡íði|ú²!Â8	RZ¢G-?"¬÷¼?4ÕÞ<·*ú0}}íCîÑµÐùÓÝ.Il}à0êÀôßZLuòC7vÍwdZÓzä Ï7E>yfÂýïý÷,X{=}pZÆÌ5]]çî#\\éEÐýÜE¶ËLºCp¤uú5÷2KE¼³BUÃU;\\z1Q%Råã´µ7y<]¼¿¦²^NQ;"õ²½ÏÏßÁ7­q¹^e1¼ýøÔå ¬aÈ9¶ÒÕ£ùp/8þC©¨ÍDú+íåcÍ=MP&Þá¡|[Ï¨0e]åºTL%fä¿¢=@øzMÞ7§©?;òÀ!Îß§q´umÇäÝ«*7+Óe	b¡@§ÊJsr¦úý«wbµù bµJ[en?*wÒ¾O!.âßuðöÒ¬ rúY=}=JÄ¡½è=Mü@F»5kvrNgeåêZíó®í5þ\\G¡ëÅioÐÁÅÜræ5èµtNÊA	.ù¬ükûfÓh½îÿ³ÜåÀ3stÁ&rbègÄáE|¹ÿ¨·H¸Þ­(b¸cIYÐÚaºÕîb¦à$ò"ehoÕh%Þ-ÅÞÌ»M¡Ä¸"ñmÌøKK#ÚZä§ªÊ®Ä°QLK$û»Þ÷÷ø=}É<ïeÈçù¹Å«aAVwÌ39Ùì§UX$ÛV(=@×õ2Kçæ¡Ó§Nu ¿ò0xQÕdU$óÚÚ½bòÁÜKMLÞæÍä!wíoà(ÆÔ uÿßíIüé	,sM	N±½øç\\%s#ä	 °©(ÑÁæÄ$=Môòÿ %ôþ&À&=}/³Ú9#(ÀmI¿I¢ÉXÅiÆ¿hô8áe0l=JPÔÔy|¤r[ØÉ	¿×±±{ö§äZj=@E¡KKÿÊL Öç¥#QéªØ¤Ý1ß7±Ý)	wå)zÙÙ£%ÙåëØî a¨³yé=M3çðÙþéÜÕÖÒ7Ðwr\\WDÅi¾å¹® ¿L!ÐùI{øIÞAåÛbäèi´Y#'	©µXZ'±É!Éâÿ",}K3µÍì»B§üøªo_ÃÔuõ!Ï?$PhÖÕÏÿq±*ôP;=Jj÷aÅ6%uøÁç¸kÙ:¶àg!©´?Iæ~¡®¯!ç¨ûPÿ]ÄÊ#çéåéN 0Kyh&mâ¦À$Á°ÙÕ6j|QÄPQãy|³ñKe=M=MâÔÀ/çÏ¿ùLÜñI¥GúÜÁJ¶cg×F÷üÄ*¦èVfNíøøqg=MPA¦µ¸^®ÖCÝ¹ù·R¶ÏÔÇÉæ#|dhµ9ö;dà)ÎB)e(q 'Ðáç¡ñ(!ùh2=}ÉÇÅÍa Øö¨ »«ÇÉ¥E¡õ¥7$!¥®Áoä÷Yï#mI]ç&ü§®Õí±ªÎ§5ð¿Ò\`PÖÛ¨z¾ªÝïÿ¾¥áács Û/án±µ@c²Thq	ð.¾ú8j9ÚÚÙìÍ2!/QqJÑËV$Â#ÄÄÄn¿=MgÑ×¸	Ucÿà²cÇOè=J*ñÐâ¢wÁÁWÛ[¼yè=JSGK°Ý9ÅÛ)Â\\?pkD¡µÂY!X=J£îÖúÏÞ\\C+mõËk@ÀpcÌp  O¥«hYZÔ ¿y±8h~¦jNù}%y#Ðª)î?Ñ!É?§´¨È +t(ÖÙÓØy»ùbBJ^=MMÅèg_5ÈÕ´A8FÆÂT«vúöTÖ(ogYzdüÝóãJ(>¿{¤@×¢ÈÎsÑ67o6Snlmxð¾+ÇSA¯%±G£ÎMúx8æ\\ð#I&Ôcé #;Dåà}	5î²#òáúÂKpSøâc|NùhWÄ=@8OùÈ\`OäßsÝp_ß+%Ø ¡·7aõ7îºÀÅç¸V¬×o§\`p	Õ³íâíÁÕAÝ½Ã$½ø6ýp¸Î=M-Kâ÷k­lÈ#Ñ#BL­·ÈbÉcº²ÔÝ	G×¨ø{ðê#ÜÍ,ÊÆã¬£ëì¹cw/Ï[ç$ÿ*ñfTÕ<²<ãeïÂ¦ÄmV#Q±lÈâ<rÛvwJ­çÇ6=Jäoy¯(±,¢Øyü[ÇCRl->ãðñæ:C<ÛÌe°¡pâÅ;b¨}óÌm'ðò1x@½ê[Húß¾Íe~VÉù=@îæÑ@÷ÈO\`×Çê5/=Må÷²Ö*4Ot±È¡Ä%Ã²¤ö¾0LO¹Æ]Q¥øcxúæ¸ôéMs«d¹ò4Íh¼hMÖYrüO÷=@¸.)öø{ö<¿ÀØïwø}ÀzlÏè-F·óKÛnÝwUËÕUNº:: ¯¯(z=J,Ý±\\ùÂÒé#«kÒãð*Òd|Í=M5w8µ=@6Óãå¸-v©Y"¼ìß\`qÈÉgÍ®U¤ìW=JîÕÕöñ	i"]=}Ö V$ýøiÈ\`ÁÕo<dVðøüõå2ÔË@¼)ï½¡¨ÖFRã¦ Äæ¶¤¢£,t¬ØÈÙþA-Ûw#Úë9ü2è//´nLôvSÑÁõ«v!=@Ùêóù°ípðc %F5ÁÅèS<@³Î wÓ$ÐÂÔ¹=Mà-èk÷aÂ,Ýã1·äQ¾°=@¼Æ%èÇyP1E¨ÖÕþ4º*6\\á2qb)=@Á=M­Bt{eçºÙà¿wLÀÒÑ®Å»uüA°	Ô×ç¦ïøKHÝîþý)øíÇ½ÆuÎAbßÍ4ûùr#/TÛïd¬·õ-Í5\\ÕP4¡aø¨Ä6Ûô"ai¿ÙX¡(·ÞX&·¤	ÑÿÄÀ[söÈÌÀ­x«ò'?Õ·4É%!&eüKËWÓµ·/:}çlXXÌð£µqAãÕë8ÿ¨ô£-Ý?¸*«Û+´MYÔØ³eqìW>5¥ÛµÄÀ7Áe|l	¦R)1ÖÂnwwOÉñU±KgÝ?ßË¿YsNY¯ð÷Ë=MH^¥é´¶Ïá.Â&¹aÕÞBocw1þöodÿÕ x >ÞÊ;£+aþzÜå.Ó¤¢¤ÎW+AÒjÖi)Ó&Lÿ.U±õ	|Ò6Å(óã6uÛqû6ÂzçÙ®Y.T¾nÏç2Çýgas	è=J³=}ýÆ1rÅ±ûdKÕü(ï<_Í:§ÂèÞÊXÅåRùÄJ¦åí:è âø÷~<ój=}kíWÚÐ8RM¥Ø}"G3§äÚ¯kØ\`<´þ¿ÈØï+7ÝßµB#Hg?§>äeÕÞKþðßcïhÄìFÁûÇ±¿cIa4ðà[uqQñ*D¶â¥Bµoè°5í§ÈµÑÅÍ@=}èØ¹R®>møl¼\\µXºÈgæâBèMQÖÌ7y¯ÿ0Ý'~E·©\`å±)Åóæ!ù/×K=@ì¸UK s4YèV©¬bªc¢Súe¯tK&l]ÏÊãìnÞÞï=@ovÞå[×ý½:ÒzÎÈ¯h?ë4§æk9b²ã/iÙøÔSQ03W¶7ünÅëV)TßoÚâÆ3¿âúæÂ«Dx÷âqÇñ-¡¿/)®b!ýÕfÝõ'á´âb)eØÞ{¾Ù²þâ¾ô4*t#¥oqì6³öqÕ)êz9#¥aª´PòÛ¼¯Õàuß®ÈdB·\`ùÿ8\`£¦=M¢½<»ønX¡»¼=@<jÑívÕä¾ÙÁ·TöÉêG~0O+$E	¦{cº¼mÌOr»=M¨)/~®ù<ZÀÅikÒ¨-²óm¯A8IYñ«uÁ¡E6XÜ³²ÈØÇZÅZOha§#¶ºI;5÷©tæ!¡8EhÆraV9á\`ÞÕAµÖÈ¢&Â/f_/â»Ûm»7=@²ß¡+É) ]±1¡qÓg!jÂ	ÍÈíµM¥÷	ÆAõÅâïêëd{èú÷ýªC\\³»Ú:¬­\`M±ÙA/fË\`rà­»EFçÂë[Çí]*YyÐ(s¶Cq£öõË¸Ò5ùNjZ©d!o;­Oë]ªúÑ_L¹I2ÆãäFêú3qÿ¡âÕÛ±i×mÅ=}°°£ãÁ!ÇTkå=JÂ{¦!©<à\`8¬·ÐÀx?Ûhå@­fZ.»UVãê tÌä,ùvF7øÙ5¤(¾ÊëÊwy§é¥)ä9¢û4¤m_õ¦Úa®î%1÷?ÊGÖYØ[Ooªëe¼aøåa=M,ß[ä²½é¢MùÏØ£*¥\`|ÈÌ#A=@Këbq¤uï©(WF"ëÄÌqáµy_ÀÁÙìøò^ö³¯ÎkGÒ,9MÕSì ýOfà&sx\`T÷Da¤Ç|*®óVõ×uG®{(^ð1ä¨ÌßFdP7s¿Åæ®àGcQaªó»¿*]ÁóîVªÅnÍ2è*t¶X!¶äsEä¼eÁ#ö$;&Ø¡öF"ÊH¯âªúíÐ~­ö4øNG¶'«é¨egV§[£Uoð5ñÁÏí¼ðìÂ+(î²~SÔ~¯æÍp_ùy~ÞµzÿCÿo<2dâÍ&Â5ªl]Á£kºpÎê·mx~Þ_T,¼	Õ¹?tP=JÿçwÁ¾ä"Ù~ÖÉXè¹gÓ>¾ôËu´V\\DAêÏz¥½«bx~\`Ó¸Ze<fNª/<úøMâÆ/<8Y&lv/¹Õßô°MÆQ¨y(.Üò=JHè|ö÷éÙæßñN×â¸	&¶ i¡ÐuEã¦©ààã©VâÖ$nÍÃUÆÅ÷IüsÅa5ÓÓ)ûåÚÕ,¿\`v<ºQ%´Wæ¾N?ýCa;kÍÎ8¦aáÚeð_þ¬¦×¿0fù/Hùÿq×?&çxä±!"åêÇ%Ç÷´z×îmH£Ég¸B¡y%¡ØÌ"H.wC©nh	"år¯#¹iCÞ2ÈÙ¡Ê=}¸Âñ·\`awWñ¸lÙwévë5[w!O'aøfjØÔô)ßÇôt¼8ä2ÎÝ*;º_,®Úò¸´¶´51OKöüòLbÒ+Ò=J=}Â+¿b;?¬ÎÏ>~B]¶56L*ko7-¸²r¨Éc!ç¤ÿî®#¨ä§õãÈ¥¶ýÖEÆ0NIïLëtVÕÍ3Á¾Gø9µqßª"W²pdK0L{Ki­®dºðV}±ê\`öý¦À¥»Ø°=J~ÆCAð[FÆÄ³ªX3¢seØÝï»[rQÈ2K ·Ë»½éÉ!ÝØ}vÔã4=M'@ÞAW×6&ôÂ>²%Ë=}×LùzwCT¿­EyqNõDJçURhÏt\`¢p_n=}£ñÈè?8Óà"A®A¾ÒñÄð¹£i-pÜ"³6=}=@½ý÷»X(ØyÂºb[|ÅîFÕ.0 ±ÈiïC+X=}@_hÏ,Võq]b¿ÑzÓ©[Ò~+¹[®\`-p7ÞÙ°{@?â\`F	ÃûV­8]Ög¹áJ<P<=Mb¸¬³ÕYÐ©ÕA-ÔKóU²Ö~0.oäh-ÇÓäÝA-òÏ¢wa|%§ëm¸#:(Åiq#ÇÏ=J	|<PÁ+=J8ãØÃ°'GÇ_÷fGuÇpïº^-§sW¬w.~VÈþJsy®v =J¦ÛÀÌ×s¡¿×¿ã¾bà¿d	U»I¢*MÆâfÄ0^=J´T®dÄáxþ8(òèmW®qméGªX4§ªéåEaE6ÛÓ½ÒKÂMçK¾p´=@T¤LXåádo«m¾Ñ+LuÊ=@Pÿ=@å[ØäE(]>lËË×¾ Å0=@Ø+¯wJËdïÁüªJ:rÇùÛÿo«ë|ö,QX±§ý2ÖÎePä¨îÒr Æ\`ËQÅÚ^³=@ZöRÄÕjwÄïU´ý×£o+É:ÚùnÏ¹»5§¼QÖ»0jj Ö8=@WÃcçâÃ½ÝTV¢ø,ÕpÌdç¸²âí÷RS«&V¾Cí_Ï±Ò(Ími«ï7ñP|é[&dÅT+ÄÞîìÛô×!,¦ÒV1?¿dWyµúÊu/5ôRÍzµ$hüòña¦Î@±v×JtW}øDõ©19a%î²äØ&wj×w1ñYwÐÅZuWÝwäÏ½ëQÅtWyÊªÜÿiApòåöò¹µPðyá¶ð"äRKâï³¤2CÄpìÖÏ¼P7d§§ApÑ»YQnõ =@ [?nlâ/#í£{ªgN2ÜN6Éd\\!PÃ¨ó/=@Ðtãú¸?ý «s\`:N©Æ°E5U}È¬ôí=}=}½åsSc1ýóèñLS:YìÂ«ÍK½¹ý@üÕÍNHùT=}BÑ>ÝDv¨^qm÷ºÁªý2A!´ÏÚ=@c»ÜóßVÊÃÐ.>?=M_atßFßKR6),µ>øùùh¿DéÚÐª_¿ºÞUäÇÒ×½ø¾a¬m°é=M[­Jí%òS¶Z¾^åÁ]ÎÐQÚ5MöKë ÕÕEgj8*@CNX<æ}!&À]ò°Ä3@§læ1kÀ?@ÑïBßwâ­ÏüÒwÂ\`Û=JlüÌJ9	?|s÷V!ÿðw¶ÈáXÄPJ ,d0ãÝï×¼×n\\YÊeY-Ú»Èñ÷@^¨Ä =}P­WYqå¯¿Môâ÷,\`v~Y1Sóà5Æ%´Cw ¢O(ÑÆG¾TvbÐúûµ/Ìí£øýÃcÝ/HIUúH8B=MOcµq´££µVOW:3Ì/D~¦À$Cs\\$ñ¤Ùæ¢j|r7±P78!ËäpGmÑBØS¼l½V=}¼Õx<óÿ}~éVíÂYî²_Áº»RöÒö.ÔÝ¬Ol0ÅhS_öa>ÛÏ_>áé¼D'ëÒç4=} Àv¦|¯y§c®èTN§:åEpü1,BlBDñKRÁÇE>|a®]«Àv¤AKì¹@·ÁNûk¨mbtö!õÛ~{q:¸¦åwÔS¤!Ò&kúÄ?g;!q³ú»p³\\ØðS4Ý¥¶èdË6þÙ¹#î_½Tõ¹o§µ"Úý;NÅ¸0(Âc¶=J)ìäÊ¸W"%=@díFê>´ÑXD¾¤æwÿÓÄÔÌÜÅ¨ÑüÅcôveeÄTe]ÇÎm{=J÷íL=}þQD×§c1"A.Bzi.]9VP¥w6MñßÄ¢òD{f>dü÷¯ôF8ç×â|Â\`½tüÙö	;]ÃÅ[É=@.õä4'Mõ.	D;¶RfGÉvò0;età\`{aêPÔêÔì¶¬möF0P×à¶6=}èóiÎ=JÑàÐ-&}=@â^Í	m7^D\`{?Ãâë\\ZP¼¸J9AJ4¨ÔDû c^,KÛe¾¶ôõª*wSÔÝØÿq¢âþPÌ=Js¥Õ¥Ò¹!$·Aê8I\`7_7EÂ°ÃòE½Éïû>»nG×½Ó¬ßààK4g»ü|É¸ÀcRªLAÊÉa]j¦â¬¤§}=M£©kpøl1¢®}E¾¶w	¢êDöÅä°×(0°àhµAz¼ïªë¡\`´Èw2·ãF\`¼1-7ÿÃÀWö]¦=M÷f­»ßlà-/1ÅuLMêQ¤yÚÃäBúÅÉî¯S$ç(XY¤@bXªù#/|h{5xKzò	^àï#NñÃ=JTIðîõá#!\`@9¸(½ç!%PÇóãºCÂ<ßö\`{ûÃ7¿fÝ¸eúr¿÷ßÄÉ\`±f%Ý£ØHKù(ºQ­Ák|Sñÿ\\il0-JõWÚM·ÝÈ­ö3Øp¼\`£1#»ðHDÚÐ-×  ÐÐ+0_ÝÍÎDZSÛ%SL?CQ]gÁè;=@d=}¯->n6mWúø§t[íÎ;gÈy(0²üCöEeÑ¬=@ðÎÿ%Øbjp.~óVþVÜ'|·B÷Cs}pEËcP&dt=JìxìÁü-÷£Dò÷	Ç**ýVä,JszÔI%ê(â¦O§?©Ý¬:"TâZIVW´®ÒæÊ½õµbpòZuoÃ;µû§^r¥ÁïäÝA=}$=}³EÝúéVòçR¤<þn­àãV/áÇZ«[±nô¨ÖÅ 2FØGrÇùìãØù;6d=@e£h²åÇ s¸¤?eYJ,¹Q%½üLUcÆã¹k2Ýü÷­2{áxÚ0tÞ}!ó NÖØ\`ì7Ûo\`vM$×R\\x>Ü0q©n¹=}¾a©üóFÄåÒxÈogZMlï¸ùw/bñÛtÆuÐ)ë4ÂëdÙBÈÁï<(O	ë:üfÂù\\ãJÜ£Tj#=M±Òº¢+tK2ÂD¸È:T]Ü¾ Ì|ÊµTdqU¥qÛËÛ3bÂ¸"!ÏÈ\\£¯­<|'µ5ìQ/©¾ÕGµF.ßs<}['=J>#CbE@ÉÍTÿ©¸Ë2¹ÃDÙ?º¾ÜÓ}FL!UíQkÍ©¸·Î>­\`OÕÏíQDPpWçüÀÇ¢88fõ4=Muç"®>} wßÚ¨kýS8x¤uµïÐª=@ð²JßÁõ}~à&nvûÌ³ÌòíØÊbÓRÛ=@Î7¡u|.¸ÞÓûQ£T|´×¾CkKÍsK­äÑ?\\ÓªM²ôi«Ä<e{ß~]K¿ø© ßká -÷ïÀrÔD³0lÁô¸´r3=}ìÑkí±ìyù¦RÃlëí°ý49FL(©#z(2 íX;_õ¸¸Ì¶]=JÒoÃ[éÏøür*¯v¶ø#¢@ì¶#{_üWä<?kGýÔõPpýõÃ4>=M«ÎÞóâÑyK\`Â,¯îò<¸§*5ÎnjqûÔ\`FwÑ»]~-Å:oq]»ÐØÅé¿ÂSýÒJõýÌå=@9ÃÔÉî!¼ËÓ?Ào»½Ï]ÿµ0#ãñ=Mr¯\\ùî©óFëçê!X·Ú&jØU\\¦Vgû÷q§t°úø¸ªjq¶ô?¶ø6ÌCËðíy¡=}ÞÄ¤5á»6	ÎP]Sz-ãýE ¿¾Ù\\DNêØ»þ^·÷ÍCÁèIeIËg4_" aA÷&88]&³ä	.Yìëw\`**¾Þ5¥b£=}Íáwy ðËãU=JmË´ýOtÇi´Å5ÐÇÉ;5ôh	8K43¹°åè·TÏÙ»=}7Ã+k×eUýÞj5ç½w£ðèÂ- rHæ=@ÞN2oÞ%½)nÚq¯³Ñ{¾ÑÆø|¦cZL®£vÇ·eódËÙ>÷=@r¦[ksë¹î_Ú¤þ¨½¹»½~«ü+Ô[" ë>ý«ûS(y­>õYý5PZr\\=}9Ýøró/0©óê«²÷%íÀ%í=@iQ]u°×®Ø(FljÓeÕÒpt)¨eYxy½mcò­pYó6©þ?Æ¤çõ¦6{ß:¶sBP¿sT|vpÊ)¯Ú|pSpfæÎ4rß!ß±Wî)û°úkè\\Ú@µ)í½Zè"eÎQaTîÙ¶àÿoÐ'/LgCäHå¢Á÷ºTëhÖnHo¢V=@R6V^REÝ;èüVðbó¯³ÿ<l¸g÷Æk?cé¥vðÚØFí^÷=@Ó¬ZIXyp±árRñj»êùtS¼ö'n»1Â¼c¢sR|Áât®ÓQ3v;±Ït¦µ-ðm.­Ö¸¿¶D¡R­ðm(à%÷i\\ÿ¬2P=JìãZßûÜ£>9þTýp¬Õr[ãÊrW@k6Æ7ÀaTD[7"NÒ÷+¯ÅO×¦ÁúÂJçK¨Czð,àf#l þO½\`©r-[Å³Êâ®6Î²ðdH2¿,òë,Ã§,_ñUu÷àÖCR/=MnÅWrÒ±¦·TBëQLVV½@¿@ÂSë.Æ«ªsJj¶ýÃ4ôüCd]»Y[ Òðüú_ ¢ùZHAç:·oOà"¼Ï,ì·÷®:ßÚD¶[¿X@PlsTû£P0÷» \`ùþõb{ñý=M¿zî°2Í¡ö¼1ò ·}²m¼1jT]¥îÀ²zPà×MývßîæwM5ó~½[ûGOÈÿpcJ,·ø\`5àëÀòï®0\`¶E»À2h£ê6HLuípÑÓp½õN¯tÏá×¨+vÂ#´<\`¶dt@àø*v´5ã·iÐöpëHú\`­=}ñ¯F÷ºÁc9÷¤mðþâøF}j¸ØD¬¦ÆI§ÚVc\\qµhÜ«&ç­Ã'ë.bÂláÂí ¥ëº±Z=MÁU2.îÈ,BãV  \\¸UÁ8KOæôù¸IÀ_$hÑöJ%"Aä­=@ùÛwTmNôÙ»ínGÂ;zB¯[36H¯ÛÜokïÉh®,Z=@ÁþôóñÇÓÊn0Ü×Q=@¯_gUîLYMYo=JêçLÚB(V:Þ@#ògöÁNüBûX¶Ò?@¯þ¼fOÌ°MI¨Ëk'[I.ú¼=M~9âPdª<ßáúGö¡Ò¯ú5¯å8Uø¸¥-où'ÏäEïi=@r* ÝÐÝKæC}äÍÂÔmÞ2Pë§>8w½ZV¢|ß¡M¸áð{:(°e½"1ÂÖ±ÖË/©O¨o=}ðÆð}.EÅZ;Â/iÀìÌy´VNÙì<Q=}j¢ëu7^+êSCõÅ9Hµp¡ñ~¯ú0¦?	áiúAh§ÃÎ®ÖË]9X:åp=@8´AëÑbI[Ù]ÈrÏÚþ÷óÀ³Û8næ¡z\`´îùõÍxßeWyP,!´¿A-HZús\`fÅË§äjÙ=};©,,Ú°CG7nýæZ§ÈMoè_ã©>{²Ni_j!)p^´)át¿#ª%±oÃèF,à{»=M±nÍ5Q¢9÷Ù#Ï¿dÛåé@+½ÌVcMtGêÑÌN@Yóf0qñdI$D´j0Ùë]éWÚÏ.iJ««LBMFè^ÌÏ¾=ME@nHìF£Ð»§Äè 3½P¦ÐÙpÝ¦æª"«=J}Þ·	Gï)ÿÜ<±ñ»ùï©£m&2#Õ@DÑc°2îÌÃ¡T°º~6?ÚT=@Æ[óu+½j½wê0¦;=J5%¯&Ô,Àôc=J~J&ÜñÊ=@áþ¯§g/½*S_Ò¥gÅü¸i¢ÓÌªQRøO"%Ãµ7Ñ£¡ì¸4 Â}®RÕ~bMf i©Û~õYµWùÙRÖÂ¸·vêJ)Âüé]O"à~UM£Uóù,tÚàVßðló{Û ùç¾\`§]ÎäÑÉø=}w¥÷eÀêaEGÎvÞEêà!¡5-q[ÌpççØçÕT@1B$ )0ä~,_^*0?Úst9§àu&s)k§á.#/{£²\\Å¤÷iåX¹ß¸êöôªú5~ºLM'kmèC}eKöcö®1óáGB°¸ÁY¸??÷(/å¶MÔ_>Xöû:Î-lsoÈ;-|§üÞá|pS-1þéæS%¨uz×U¬ØÆB®à¶lj¥¹dÄ½· 5ýGM]a@zÖCØ×c³Òû0,Z,ÉuÞÅ,ý¤!ÃKßú=@g;?ËÁ²³ÎVg÷+Yï?6 x/ XWOça6%J¨¾Ôú~{VÑDÔÙ\`¾"ûAI1ºaØ½Ôìúf@­Ä¿ù=J÷;ã'þ=}g2 Îà~§sõèáÞèñÃ0©aòeþ>©ÿô¥gÈ}F¼;¤xycÆàãü)ÔtËþzèPÇXÅ&×oV§­ÄÿHñ¡fâí²:Ñ×öC=}ïlqX9~n»Í3'\\Q«ÌlyhJÈ5´YÁéV2\`Z¢,úÍ¿ ¦ÄS¬ô~$0×¶G§Bæû­)qëVqß²ÉÈÎR¬@éÝ;ÄoLµYt2¦½ÍÅ}Ò©»ÅYÉi¥¯ïð	ßfø)ÑX%-!(ð&X´7_	</ÒBKif8Ár;Ò\`Øjdª vFC75§º¬*®Y\\Z´·14ö.QÅÚå¾ÔÌází/¾õ´À=}eS¼coÆn¶ÄáýÜ¬çUÒÔ³{wcìñï"Y?¨¿éñ <c¬³×¿";ï£HÀ{ªFèÂâÎ©Ï£*¥mÇ}bq"ÞB9~«(H	Céäÿ*#÷Àý@Îîÿ@ê$hÎ\`æOàøØVM=JH|³Á	e°±}y =@ÁN"Íq5Â5ÏÎëuv©uh/1¯Bñ,Hëqvä¸@=@Û®äßC§*CqoUüò¯Àà¹2Hs¯p¦®7m {þEN¯ ¬aî9ò!û«©^øîMi¤m'ÍUíÀYÂù;nÐ!ÒÀ@*§7õhçvJ­ÆÈÍÊiêDcnXXbúP uJ!KwGì=JªûWïÝS_H<ú,1*¯¶=M¯1´Dw´ô«8ÛhimÈ² õç2Å¹éÉTãøð?´-Jñ+%VfØùÌ,PuÊîµÿÕ)hÿ|íjÕ¾þïÏóïWy´ì]=JNÝ\`ú}ÇÑ_ G=}½u-¥ÌZµ¾ñ%øÅtÂ5ÝvÒ#Ü¯3Ö¬	?dßb)JwÔ¿PÊtÆ'ã¡eIÉNòÅ¿¡5çdyú«3Ez:ZÏ=J3i&[û3\\!üååîÓÁÙU½¥·tù\`àé³ß¾ÕPâ?¼þX0Ê2)¢Fºæ!ÁFÈuK0±¾|*ýNfBTôSÎ©§N±æó¦RêææzÞa±s\`è0_ïM~î7sDÆóo:U#¢ö\\V¿qôOWÎÀ×Å5èÔE $T£=}ð;_ÊïTq74êÞF¢ûÒÕ(HýíaZmà4Ú+>ðÎ¹G#¹V8ÿ/þ°îo03ïsQÌeÉO¯°]m´£×<Üý@5oøz+þ\\JV®=MÔm¤/=} Ô\`Ý£èû'/æ .L éo¡¥ùzëk=J	]ßûÂQÑ§ñ.ßkr³JfWC°Ò¸Ás°¿ÔÆ8WºX,hRbôBb'ÆP2Ô¢2®HtÑôhM¡Zf¹¢Óµ3ì»C;gqÌ*­¾3¾OæRGÌÕÎ¯ÖZ¸÷¢iÊHdÜç¤óqáÅbÁ?@®;X¾2lØæq:Ðø|ººs7©9úö(|p÷¿éÝ7TÁÈÔÜÑ¡N­6Â°y*Ïî¦*Z|¨<³G£å½%¤rÆô,kzÅJY©½¯t\`ó4óÔÑ®ó@ø|¿=M"¡ã&õf¥5midu[l³7ØK^.¢EÿÔ½^°ýñ°ÍÍèëÖ[1'0ÇySB§ë |<õ§Æy7[¨ÈV¨àPí¨·.½AÒ²¨Òm@=J&-)õ¤zÖmô5ÕÀû{ÓH¼tôôE?	-£ª@ê[ÃÊl¬ADæD«§ä²Zto Øk%{0D}=M2=Mº6Rîgv¶tá\\ÍJ!M¶HºA¤}þB\`5&¦Àôs¢ÙìàØ6ÐýÔS¯oßàµÍ\`bOHnPâþtðÙÃ-ÅgY[q¾{c.6£ö[½bE¤µY÷_Ê	Kú)Ö¦ÏQÞK=}qÉE>ÇÙÓâ¥Oîí(9-5B#=@¨§·¶ÚÔ8s"_¼bq±>t¶§Ê:í%úxqýF³	«B×ù·³÷ÁÉS?Kçõµ¬®yÌ6þ«Àf±êöÉKN{D¯gð§Ù©]*?Ö8?æßçº:kÂ­p:Ü\`ãºÿÑAZ_M îÇSúÒøí·ÿðùO0¥OT#ZÜérxëaªÕÑ#~Ø=}ÃÃ>£mÄí»ôË§'ÔMì¨¼ênîâ<=@xLp'ýì7K¹ëÜ ¤­¾÷eí$ª9Ì¬@Çõ3ÿ¥±:7À¤ø«ããI-WêtD_I.«.PåmýC|)_M¬¤Õë²Ak@áoG¾=M|*=}æMÕwPT½_V±]Öäb3YNB_üà|òô^&kË¦ªwÿäÔÄjlÎ=Mº³+IH?xVyÔxÓ­ÞÍl@ÛÀ³ÇÝð_5±9îxä°§#Ðw5jª¢F6S.:+#XßÅA½CÏM°&e£õM½¡a{\`¾ªìöC>Pa,>P9[Öú%²Üí&pC&pottV& ob<Ä±Q=M6ý²Ý±Ä«Ú²£KµË=}?ÈyÓ±f¿4û¿ àÌ¦8ÙYXðûÅ~É/éÇ|P'\`I'N¾	F¯PîvÝ5D°J¶ç¬5ksêâCî=@±Ñ=M-SQ3x	pËTIúa«dBmfÐp#ÂÑlüúÈÑo6Uì³:@lÉ¿¤UwÀ¹þ%sh¬ü{h5óñ°5têÚÌ¡ÀPÙþ6oæ·AÂØh÷8Ä9Þ\`á9ã&n;¥g[ë[ÇýEõmÖ½=}ÉÏ+·Gp¤¼iÆhl9Ñq3àf+½J¤½%BN_ï¯ô^8ð=M»©¥O>å©¿ØMÞ¬þT7!ûÎQÛõí?vÏcÇb9´Ýë»ëÃB2ãì/özÒÑ^7>¾Çß7_Ö"&Ü7ÿ¢3½c\\úQBNÆ«ia¨ð0û_U5¸£ò§wMÊ7ä´<f¨Ü99÷³%{uî[ØèÂcbã9Ñ©ÇkrB,ÃI±dÀ-jF4ô-£Lé².[v]XØó«¯D@Z+z1ÿ\`b[Xo=M~¶ÈïsÏ;õv9}Î±¼.¤nKÃZo¸ÜÂ5:vÆZ½=MÅ$äAÍRKN_ºJú>ß·:|Á¯Õ0Äj rõ>X"Ô_0æúN0j¿õÅØ#Á­AChâÿ\\ÞmrTéýýNpºE=@æÞZ½õÄ<ðqE@ôjXFC@*ÆéåûrlÂ?ÿ¢ªíéE?ÿKoçü^óëRÎ¤n³rASV*}ûÚÛ­7	ÚÙ_ÝS(¯ Iüu"ÿtD(:ÓVÇgÜpÁF,"Ý]"ÝDíoñm8"=M!Ë?&%ö\`("'SäÈ!«¹¹	ÉÔÓ¨IùB("§Q"=M!=M¹	ir1#'m§Ò	ÉÍcØ¿Ìzµd[xß4ÈðzÍëhàíÅÄàsÕÈ×à´sßû#ÐR¦¥ÔºµqÿdÖÒ{öíLu»,¸	ÕÒ9;Õfqé@FÄÓ®e1Ï¡ð¯eÝýe=}íÇÇSx¡¤Q4¡ÐÐ¡t|ë¸çW6¸R¸¿T¤ñP¥ü¸ÿ\\Ë¸ßzÕXç]y0WP»ÛeÃÈhvp}ÒàÉPµQÔ=J:²F\`Y_ñ²fÁæòÇ¶©ñ,b£íÄëhRÊëÂÀ»¦£aÛ¥0û¤õÚbRÆÓåY¿ìy´¼MMNjúÞOZÅ×ïÒY7w?;jï´ù;÷Æi£:ëüÊZKÁ&±ð¨!ý{J0JÎaö6I%PLMÖ=JÀg÷MÖ>þº<óå!8jØÚaÊÙ=@ Ò)¸$aIU i¤°üÏi?^þî×#Á«üy[÷ý¯	#=@k^P»2¬Î2éÏÝ¦ågîÂ]êùß'>ÑU²Îq SÝÔÒâ7m7@âkEOn5ªL^BÚYÄì{¶.Îúmo*ªò/;â¬GìÙòxÁ¾Ç£ïÄdjëjñ·<«wm>BH@.ÿ®sµZ«YQ¼ïqöY^+´òÔLÉ_î	=JÛåçu½So7®ã¼qz¢bShbhîsÞ5ÞÒÝ¬"=J5>æB3@³Wª½8»A¯ªõnÃ:âÉ°7ªsw\\oÀÆzì"Ô'??KQ\` nÿíLá°¬ÛÛÛUÌqÝå4ò0÷äºð\`Ù3G83TõN7Ì:Î6KßR4àÆ BÇ×Ý+B6+WÓFl'®Få(ù°ôCenÛW¹vN|ÌÑ¸±¾wÃÓ%¿ÉFú^2 92­¸ÞXø·d®qªø¢mÈjÞ°ÇTu0@çh©J,3"Aú6ë\\Ãª'zµÅHq¾¿ß(»)>V|©Án¾â©ïÍÆìÉ16§ÛBÏÒíw%tJ@þ4G(T:)NSûB§>DÌs-RG¼Ç¿'¡BÑøÍr°=JÊf{C6ÂöZ·ÎQÕ^?d³AXEæ|G;ÀX{*sâa*~>»áøà:¶P6úÃ=MA¹?¬<±ÄÿþLéXyDLºTÌbåþPE\`«W\`ÝîQ¯ÝsªÅ§¹lFmÀðGõÚÁ°½}|XPDDáGÌØãV½aô«í÷\`^SÑÌ=JW±ÈàæÒ­/ÔRf¶ïïhúØ,N<ià[±A~ÛÃI×jÊ÷þg²Ëíu¢cËù(±A	ì@òrUº,!Ðx6ö2BÉÓsµÞîZ[Ha*	!ò=@®JÃÄ»Óó$a°élmààxÇ× WOÍý½oÑWlk5O;Ü-Ï\`zÚ´ÕãÍ/æzbð8B¨ýØ£§Ù»VTpcb'På=}x@dR¥3é4æüC]Ç.5	5dtØa£ó&pVÝýö6¢Ð¨_qïÏ4iÅµ¤½Zä.Eü3lÞ;ÉöØ_K³ùPÅO¨D4É@\\Â\`¥¿s+Ò*×À;µ2÷45_º¾ä¯ôz¹=@FùVý^)ûÃäÊ~¹å½Ûöµ°\`øxmmfTwßqüvÞNKnwE7Íù+}ÐÄìù×íã9¸UoÄVò°ªs\\4|ÙQ÷òz=@½½,=}´n³ÇuÄ²KÁG·«¾¢2á¯ËK»Ýn £lWq{ %\\]6ÂÏÏRõNmU»§Ceª b&3K¨w[¢>;ÿ7E]ñbp~Ç@Ì aG[pðâ£l^£³[Wuä ±¥$f¦\\ûþ¶vÃîº¹ãv³ þ@åÑ\`äÜ2c	Ö)ïÜà´Üb|gÈkî¯öÌ¦²O·\\ªoNAu°E¿=}»{âûÐ¤Rï	N»ÍBg9ÛÎÙÖBg=J\\=@¿ü8õ^cS«nÄå\`j&ñ2fpY£(ºéf=},R(uöK'ø{%ÒªøÂoôqì-".ô0xíÌøcv1V\\£%K>	p'ñoáÙûæ÷ÎÞð;C[~È\`ÛÆÁdµlà	âëãdR¥§âByVê#Æ¡ÃB&_æõHjßÔµçXçeØdÓÙT[o11]êv¯á°§³HB;·\\øV3^ßÌçßû*A:Js<bÁRuÊÏ3è¾/©¾øÜ|Ö@ëØÎY.¤«#ÎØÐõºC=@!:SÁÞ#F,Ü¹Ã@MyzeN¸+Ò.[*yWOLyáE6P¹=}MmwuûþÞÄîS /S\\ã¶tíSþ6¨Kþ9Wÿÿ¬¦!MÙ¾Õ:·	{ßÂU~7þ×ä/UdñöñUÄ­9ÃhþÔ³czÄ*qªE*ÄL ðÙ¸üÙC_£Î5ÁDD°m¯aV;Pç(°zßæo·Rÿá²¡ÞÌSôIeí~D­©Ð_p?ù\`pÄÉ¨II¬ØÿDL=}ò2q+_îò7»b\\r²ºx¥$ZÖ_nl=Jö+î;õÛ$Æszoÿï²âÊX÷ÁÞXDÞGþo®¡=MÓ¸¶5cFÂ<Þè©xcp¡>¯Ù³½ÃÜàC:î<Â\`(BK4\`\\kjÐ~Å¡÷ ÍhªôyE¼ÜôrÒÅ÷s« Íx7Oô{z¬°åGÉÌ{ç=}î½=M|lö\`X»µA8ÌÙôà»ÊdD?$vÓÕWù	âs<Ø*Ãvf¹¹ör²$z=@n/Mó_pÂ/$¹Ð#EØÄò\`ýLô1[Hk¦Ì1dÌæKcß2Ü"2@!oÖ,?ù6×Õ(Ó4µîÚU§kÒ5%c÷º§cxT^ÃAî¢gÚ¿[þ3þz©ÛàÍYf»2$T)qèWÙÝW=M±QÑz]JõtßÿäÑ0çUâ47	­Æ×ÒÿÓÒ=}f¶¼i}=JY¯,³{\\«@CM*ÝqÙøYÌvÔÓ]Þ´á2'öò¯íÚ×oÍ8úé=MÃê ¶¢UÍ»Ë[è!Û=J/q?\\>ü?W\`Ïï3ì®Þ»!sºð5EdÁ°êÍÃå;¡Èñ³1¾	F?Ð5á÷8.ä¹¢+1YÔ  ×ºgyþRë?ÌNÓÀá@ ¼v×Iµ¥¯¨»²6àõlK{Íåð=@/G»F6ËÄF×yºÙZ_CFY,XY·mWänuì<¿.£ø*Ë¶ÛnxÌêï°³üRwªMÀ[j¬Kzþì-£w[²© æIØè¾Yºþ,¿pú«l>»ÖgnÜãY¿¢Ñ;Î¹E¤Âñæ»V>ÌE´9Yq"øÎK=};C=J²ðÈ¬¨¬o^¿½sÏcÁRîtÍeAÊÂ>mÔW´ÎñÕ=@FÜÿz|±\\¿g®BkÎI­A·ÃzÇ^³¼V}Ða¢fæÒpùãÃÆOJ²I9_Éòv»¹»z}¯ÄÕÛùdéÖþÀýÇ>ÇPäúÂcl}÷¶Æ­Q£X,qøÄ+Ì¶z;3ßÂr2å½Ãjý¸Ò±RB*=@ß*7TX6¶ 4Ý|Ä$Å¾pßABî×§b¦µmsß@ñE:î÷X¡½b'Âq7u_ö¼Þâêàý?hÀ·bòG2|LÂ|È½ÃÛJµÊOÂ¬8s!òq¥Â¦N6²LZk*çj+$»d=Júk·MH»òXOpåù!ÊÎ9pJÙéâàVøæV ×â\\­é'ÒÇAñ¯K[)Õ£QèØ÷ Øa¦Ý·¬'q×@¹¿a))y)¡±5=MÏ7³Ì8Ä07=@ÉïÏ»ð>Ì,õSí4±	ñ}R2Záêèå*û^¦mì@ÛEvP\`	a	 \`G´4õv&|rx4F keä¨Pò_erÓ}\`o-åàÛj¥b	s¨Ë7D²o³>Z=@¬Ý2cxqnÝ; t=}â¾*·×ÌªûÙt|65ÿ½Z	g0~{#û«*g:B[ÒÞVã÷9éÃN\`pÀ\\*-vµÂö3¸ºüÝx<Ó©èÓñÜÜÈBwüOxdêòÊDHýøÌX?òÜþ­ÀºÂ=J¬Ð´(]A=Mîv,èX@|É;à£×·:PêXmHkÞ¾Å²^/å»!w~2,?®¹$Mé>ÔmÙI³m=}\\áí±àks	]á½á»Vþ®<¿<¼í¤N¶"éÚ'ô´pé@´Ãë5äqkåI:"¶seDº{mP=M®I_,=M·Xð=}¬t90Ðö¸ù [Y{,ËAÝÕ¹B$]­ÖÎîÜÊl¨ýDG*{Ð×Ä=@²kms\`5ULAÂ<\`óÈKø¾}Giz§ð,]åß!\`=}lÞ[oÝ¡Ò¤ p 8àOº5É­ßcÂxå(Íña°öÖ½^f]¥§ÜßO½¹£äz|âu?ÐyBåà³®?wdsÜom8,¨À7·)Üg++ÙS»°¯Ë¬Þzô8¿Ä[]]P»ÿP~´ôÃÞ¸DåëÅ=}	RéQhN}íx¦Ë^¬ wÚ]p¡ð"Þ«0aîaË&®ìâ/eKBQhGö|l1gîÆë&6Ò=}ÚÈZ(bg¥ÈÑ|µ'6\`­ß.¡ÑÎ\\öT}dþSU>ø4@JÂ©ÖBzä.P<sSyuS:ÐÝv¢õàv¢±f×?FÙÊ>ÐkÜ}¸Õý»7^,Û}0°ùm[{Mbc!Æá[ìØÎn?æÛ<wP1ªÖ#ëEMù¨ Õ>ë¦Ç¸>ßhàcÃ§iÍ=@Y	õÔ³þÈDÅûÑ(KÅ	ñí¹>¸DÏRØBp£YXÕ¼ÁNvÇlrrNbÄÆÚRÿ¡Ü³ÝiOôÏG¬uÿ{ñ(º7CËEü]¿¥¡'Iì¹X_!Î<:Zfÿô°Q¨>|;½çý-­	y÷PxÆí«6Éô´Õ?°NS«AqæbX6òM¶ðoíÃäï%mØÑSc»Ù=J¦Ë?}ý5ë¸L>/¢t×w_Êc*BvÉ¼0JBxEªñ³_Ê72¯<ZÌx h.kjé7ú¾+AëYvªBÃ1eiy¦Ô2ãèöæÞäÃ([ZÃÀóö}Â5ÝØødSf¶+Ëx¨1é&ë;\`ðÉ7ðB© ÏXZ"NTþKÊlýÆI/Ø6%¯°®þYO±7Hó¨Ë+vq}t±úÁJç¸\\.ÍÈtK®úzB4·äµ {Kù¸<n¾[tÆ²¡,¢wLÛy©ä»ÝÖ%\\=@öhEF\\ÌD2ÄuÎ6O²L³Å±XÞapÚvOUô²´^08%DBÙêÞ¥Î$G*6Èíí"ÊDÜÁ¶ûu¨ê¥N6?98ÜkdÇ¸¡ôÍÂ¾d]-õ\`Yu¦SÕíÎÂ  Ùê8=M­´ÀËM·yDQ|éOnÌ ß\\È_aýpGé=MÄØ3_+Ôùþ^ë+6¡!Ç÷&Æ=J¡ÿ1s=MÍC·?p¬OjÝìÎ)ö]ïÞtÈmg(	N	ÀþÅV§;òÎ÷;½áÁtÍ[vt±½öü4ò::]~4ã6_üÛJmt½Û=}8lBxq;x¹urr¹§¹åvËpæÕáO½eÈ.jÁÚOUcÏs>Ðó¥ýGRÜ\\øÑê¬âÕr8l¯6-««j£-å·	p=M2pÓ,£USÁÛÈçázìÖ-+O.±¦µZ8ÆÔÍa ×xí3âr+HôöutYÎð¿æ4¿#ëlès¿íy'íâioå¯ãï·]Yîj}6-t1ÆÜíÄ­«5ëÏÔÖ²@³Otg×^D,_ÝEy¤÷$«Í{k|ö<T×*IºTúÔ·'à¤+U*xFµ~Sðé3×+vôÒÓ=}ë»zP0ß¬ÿVX¶wªNEÖO^aÎ?ÿÑ"^î_½\`@@f®à¡rÌ9Æ)²¬%¿V+m¦=}Ôª_âÌé^Ëbg¶ýoW{ÝÞµ7Qã9RÄGÝb~ÙÕ1åP¯zx5Ý	Ã¦â0ïEÃayQÙ¹h»Uo½\\S2Ñp¯x¼³±WÈ\\äMµUÍ-Þ1i\\U(y=}W ðiÃ?)V²­dgÇÛüÐä2ÔÝÕL_äo-³Wß«hX¢¹ÚÿÑÝyÙØ´µ%5µ]LNN×çÌyá@sá¬B)%Ô"ç=}IÙ/!O§×6aWb~+øÌh=MÂ¯BÏ~Üõt¦C!Ðã%÷'U1@éÃGEÚ!ø£"¢àgsj­ä*cJ¬.à8ËÌ&À;é¾¢ìDèî¡ßÂEä²¨ý_³ÁPCÖõÒuÌpz³Ìón6Û¾ä²¨Ï¢tÇõëHM=}r;Ãª,.÷ª:ÂCá¢Ì78¯wÿp,ÕLØÜ2×¶Êÿ.mÍ³EÐ\\PÂþEáÆáNÿ[ïYT(«êØßY2v*|WÞr±?ëZÎ@}lD}Æ6\\\\@·¡Ë·µ FwpÒx½8äKín£°4àÑp¡÷îHÐ·RÅV@¥ÞµÔÌÛ7ìqóàLPìXB·¼÷²ßô{ÕÄý­$îWµ=JS¦Ø|=J°¯c@¬zKÌ×µÔoûÖÑ®W'üñÝuµãÂ;m@\\.åtXæÏ"PZ;[ý»Ã¯öZ²kÿCÝÙu{rî)'Lsf|KÒû ><Ô	Ò¬ÍÌ1Õ=}ÌLµRd´Æÿ{qZKKM<Ë÷}!ÇbkWóã¶ùpë±¹´ð[Ü=}¹Lh)Å¡¢»)A¥ ïªFMÃè¬Ç¢GL&âPÞÀI!P¬R#ã]Þñð»°¼=JäNäåþAcB=}ú01Àüàç(=@#=@»pHÛàM°ñîÖ^\`¼ÒZC¦·^xÔÒhUTP@½=MÆ§_Y =JÜÎ+vÉcF¦âï\`¡k%ï1.c¸Ó0°Å»IëI'Ç½ó7s¯ÒÔG¬ÊÌðó¡î×çEÃðX ®ÄÉ|ZA²êp^ß.Ý®5$Ø¯5¼¶8P.Ùû^àFÞ1£ÃßÈÝ%uw\\ø¥ñÞARÐo-o4£Ù+=}L ¨}/Lª@Õ·§0úf:]xe? rFÜ²·Föðp7äÙ¡§=MÃôÑécày6Gugÿ·pJÕhnâP¯½¾XÒ:ÿ8¤u ?í-îäÐ3YÌúDß-gDRºRmÏ­+ßïjÞ9[G©éÙó»GÚû[¢ÈëöÂãË¬Húrð£óÁÐÃ·¢-¨²©]5@öýÍ\`C>kFZôõ~­ý¡ßÜçÂÒW)@ ¼Cé÷oèCPÀñ³ßA²ÇW¬ÎVS¾C{E]èe3ì×«©~£êóÎßväÕ§vwíëq-ªtGßÈÍ'Z{ÝáuF¿ÜÛÐ3X,òañ¤®,\`KðÎ«ª! ù¾ìÞ=@E7¯´Éæ¾Dá:×°òÜ^âvG[Qð×[úÞn][Nù5Kà¾|Í:»á7-úblPJ¬aD¾à¤ÛqrV¶ãûLËÖ+ilse@rZb~Dvs¸æd¶ . ôÿ6ëÚÁÐ¢=}Ë\`N]Ö^=@eÆ§ ³¤ÒíHÓç4|pPàP.DVÐikêó×t¥g->rpÕ¨@3Ù\`0NR°9tká«£Ê=M9oÃB ûYÚßoøG»Åe:Àóñöz©³ó?tþj5®ÒÊf*\`ëÖlÀózxÃÞRÎÒªâóé=Mdõáëk^çîl-òø«ë©h«F*Hà0cÚ¨ËúïÙÏN÷¿üÙ(aT.ßñ±þöréD®",úI¸­jô®ÀêÀUÐÐwÀÇ? ÊÊ-ùk»Pó"Ñ° ,®ªkþ*Ï8ÄÆÈÔÂ×@î|DQþ3qxuº¤N6æv}ÐàÅÃjÂÒ®WÖ¯ÑÿîA{:¶:mBLÞüR+ÌËÕ^[ MvªÊÅk¡¹+ÈÖ0>¸Ë6Éò¤y÷[:²6K½ê·}ª0äQD:XNháyudB=MTÚQ"£8-¨è}òhÉb<ÆïÌÉ.ÙIé:3Þºd>2õ³Hï_¦¸$÷1?ÈðÐ9)'Áj£ª[ê\`©vÞRWúÍ=@ÍóU?ýîàøÀY}áRÅÿ_¼î ~µ=MÁo¢ù¤äp=Mtò8:\\Û"Wðt«*âï²Qì·ì+"Çîq|Pc¿ÍÎ7½ïÛ³Wü83¦Ö­µVðö´!$dÄÚÞT¿®ö*úæ½zíÍBPIN]&à²æài=@©uqL~ö/Ô5F­>hÍq¦íð¸û8þÀj'»Ï=J<Uì{©re¹,°Êö>Ü&)¤\`ÌóeÀñ4³òâæn½ÀZ)Uå¥^û±:4åd"½«²ªÿ/r'ÈDi\`ÄÎI3¸oç¼«ó7ö²*îHÀêG­òìÚ«à3{[aWOîâ²c×z>&-æÕÏ\\0ðÅy$ßE¤ç¯³ÕãRbh®¶tÚè7+sÏÿG<Ýò;ÖT¼®ï¹]QPo^+qVs¯¢u±×úAä.< únÚÕÌêe^pª\`qåìbì^öt^¤,9<bßÃ4$¢GÿzÕÕëüÌgj\\ÍCü{÷Ü9ý=JÄuÁIÌj=M7û;|£ÆhÐ °3ÐÈ~z¤ðV5!	£Rmëq>Ö=@¬s0´¬_"E3=Mjª­ñYñÊcBeî'Ý&«CÃeZoãõt¬1ëGÅÆú7=}@×l[QJF>%q¡RíXöæPDøôÕë÷6ãåì=MÈâó%BþzýKæHüÂ_Ë=Mýðm6#<½-Û¦®¢ëA¡ã«àäÏí!!Xà9HGK¤],PD\`A6-)<\`°kWp¡v¯GÂÇ¶fô*ýRTæ£ÉØæOw.CÃþ:_Ü@0°@p!fø°yN]s§;!îY%=J¬·ï0¿©.È0Å¢ò[Y"o78Ð=}¿gª)[©êL2~;ü|¾[{'Ú¢föÊî<5GÁ9a=@ÓC«.å9µÀBÌy7JÎì=MX.F.&ºÙ7ÛÌ zP#¤-MXOÊÉ}8áþî§¹d'ùWfÖnXgðU=}iásUWbI7®£]³Éh%iÙ¢Ï"àY%ufwñafìq¾¢¸î'´OÈQÝ7&ßWN%=@ði½Ár'_©Ün~­=@272eéawh¹ÝÙ¾¬¨VÚ	B(tdlìvnEtkÆYÜ\`Gé³)ÜlÌ»}¯=J"ö*<Ð¿å!#þàAö¶X&FýÞ´ÀhÂæÞPl*t«¶ÝRWu$ÞXRe>=@J3Ô7eÒSÿLW_1\\eÛCSÔk\\¬EÐ{ ls#Âñ\\¨¬²|:Y[/õÄ1TºE-#àWA®Z7W·¥£ õª´¨ÑÛimó}»ãÎÏôQWuÏj±tßA¤ÁÀTÕ-UÑuWïµbùHÜ>Ù)´åÓjd»¡múb=@E÷F÷«Û4à:ªLW·UApW<Æ]ÇÍqÏ¼VH»Á¯Ai\\TW}÷|¬D2ÝÃºÊ?R|&£\\!mR^P)¤ÝÌ­tóÊiUbÆ¢ët<çâ±TéØâváNb¢[I¥GbÍó$Ñç­\`úkm!°8ÌÄçÄJÊÔT¸ëÔgäN}ÿÎÔ¯~_HmCD\`þrÅIÔ$Æ{c±HÅËqÖÛDBz«vwv[ÁÝ,7Ò\`ìýÔ¾q´(ÑÎëWCnú±}ÍÐÆ·j:ÜÐQötë²>h¦=Mñyx~zÖ$f¯IûIÓ\\°½9l<î¸qTÇ¥e¼½N3î~ kå«Á¾AôìOòÄªÿè*X ôU«xòT]{òêì LØo/ÉÆÂåÖÊFá¦k<]¹áª¶d¤×	þíqÖ¤)A0(±ô¯%aÇ!]% ¸º1Ü3>HE\`¯Q·Ôá(ÉiiçW¨R¥çñ¥&"g-XqSJÈscèÉV¶Õàµ¯|&¿i$µOH³;»1ãÕ5K)Ræ¸ëik;fÛØ£Sã(»u/LRjÕ¤½ÉåEÒ©eFmßÍìKb¼h(ùYt{=}gNqSäBøØnõñ)¨YS·=@åL@iÃñ%¿8ã)l[¯*æ·d0:]lcÓëz¿eÃL¨&þ?Iõ@=M¡ofü=JÔ¹·CtX\\É9U||îÎ»µÚhý"M»è=@t¯±0)J×=MÃ°ÀÃÖ9N>^ãÓ@ÒÙØÒÙ }ÖëÑ;ã^×\\Ô\`=}y^ü% ðÿfäøAEàÆCïX!ú}C èÕà\\}2­¦ÒÛ¯¡£ãía{ÉÜÀT=@¨·ßÖù+ÍÞ$¼·/óGe|x÷Ò²ßí«¡í³Ã<·G°ößÕ¡ö¸7§u1x=M¿l&\\oNAöü$´¢R ÜîQ¾2|÷4=M'ÛÍÈg)®l l_ºvQåàûüÊ½ß?ý´ieTPé}ï¢éOïÖ¦À3¶Gy¨0Vâ_s(ÖÇYHq§3Võ¶ÎÉEÎÝ¸&jÞI[Nò è&ã¿ÃÈ£%@!7}C:Våwîè	ÙB;iHÄÌJ\\+cËqÍKd1GËou9ÕUµCË­à*þ{o7fx¢èÔìâ¹ÏjÃ6]AX´N¾1üÝ»ZÖ:-ê'ÿùõO=Mó¾V^+Ijz*_a=J[¹:ôì®òì]*+Ücó=MößJÞíeÐl=JxÎ_DMñCxv¼SÆ{jD8á1>7Í­5J3²¼*×_.Vô¢2©ÌI{SüKÚu&ík>u¢îÃE³#¤CÁ©=}ºí|Å°9Öeað d¾Û¼ëNÂÒU¦âõu58ùwóÃ½§Fo÷ê2æ?çöD|dÎªë*%W<îo=@«À/ªa­jð[kÚM>'æÎë=@/ü¹$ËñX÷,]¥¢ÐsD7¹Âx¾VEÄÿ¨3 PªJÌ¹{0¸:1î¨_VbÐ=MãUM! ÜÂYØVûàúáÊï[úï°¢<«fÂÅnÏ@§þLyÈMÊ¥|¢kvQ¶4n6ÅæÈQ®0>Y¹Ðç«²v¼áäûÍçÁù{å"ôÓmd!ÆHUbRÎYHæ¥¹È"9m¤¹È½ùÃ½%EÉd&öù%Nç=MÈÑ?m$û'1!Ï!YGR=@=J§¤(ã5!6ËÛg7i&IiÎId¢ï)æäãó=JÕ9'·­QO		ìã	Å¡¯ùìèßÓ±Ð­±è=MQ'©rÈÂ'=@mÇÎÉÄ{(aA¶åKs) =MÅÀß¦KgYcÈ#	½fIÂ	ý%rrÙ²=}©¢µ)¿¾B¦èÕY'µK'àÓ­Q èÏì!1 v$!¹¶uüÍ¤h¦ìØeÎ±ä0a÷é¹=}88wý¥è#'ç@vhPÎUñfµåç=@ºhåÙI'I2%9B&·¢%Ix	ícI©«¹±)¶ëXäýó	¶#ùDü1 æ\\Q	" r©¨ùOq¨ì+ivÝ	=J3¨ºhcDä&è$l§¡yñÖwÙ?¨}0)ÿÝð¯°ëi)ýeÎ'ø	§¢'K±®Þùi%ØÃE@°Ø1Ñh"­ÍHüIåÑmõØ¥ÌYÎaGfb=MîÉ©ÍU¼!­a!yI"ÓNçyÓ%éZ:üaGd¢=@ý¦K'ac¯Ei¤'KçÉÈb¨üüÉN	ié½¥g_çùO=@}¢Û=}¦OÓ)®Èai¸¹æé'i&É7É&	;üÅ¤Ð¡ù8qæÍk)!±Àó­'Ð´®ÈÛ£=MñÇEüF¹'ì±mdD³'cß©2ËðÈq'C§27ý1a¦·ùÖ9 &©¡|éñyÅ"=@IQÑ"òi!ïl¤ÖëÖ(®i±ó=}¤	³wGé¹ #ü¿W$áRÎùIý&½\`ÖgZÎ¹£ùÝñ[(ü/K§Ë­±É#öQÀÆCüãùø'ø5ýiâRÎaß Æ&øi)!ÜK)cáGeéÙäPÎ±t­ïðEÙ)Îæ ë!©äe\`2ÿgc¨H9¯jËmaæ¢		hCüAcâ!ÉÈ©QùU­éäW¨¡¡=M&p9hÜQØÉ>üÅõgé¥	U¹wa£\\â)Ð×$ôæºþ[b(YÙöK'(í¤¨Ú×%çrP9¨ù?;y!I'àë-ÉÑì¯½1Éæ)¾áøå[ÎiÂÝ©@»¾Áãì£%·$krq¶ã)G¾É6ÝÆîød&µKçä=M¿wñúèÀÈHÈ£rHi¢ñÅià©r¡}%'i¢¨èÅ(&Ý³5½"¥ÈàR£Ff¼w¢ÔiÎIE§ =@ï"r9ç^Õ1f&Ál¤=@c¥"yÀ©eÎ%©_$¹º¸(Ú°S%ÝK§(­ù!»-ir¹ÅZ"ø?½$øG'åúÈ&íâ/%®é÷#Å	wbêMl$-g	Â%9ù¡rùC&ê£xgÆºøgÝÒ=}H"S©IüYa7ñí©!y¯#Y¦w)ÐºöÆÑéé&Á6ó=}¤ió§A(ZÎy(íÆÁw%Ñm¤¡¶§%å©#tr!)¦%¾ù¹$§éÙ¦Ç§±öeÎAX£!89)¡ªo×èÍ¬J>dÌ~oë¬Ò6´´W´çñR-LZJ÷ØRû³Dåû>ï¹?¥aðØÛ[!¥Ù7ÂÂÉçù))39	%'Õg?zSgÓ·îÉær'ú¢&Ê<yhF=JéßI°rfêÒªtãøyÁ¢Ù]Ó}ÑWBã¥ãîe´Æw»"ßÞþC'éÔæÞ´QS#×Ì¯%\\èû&³ÿ=M=@¸àv à¾­îEv÷=Mt­ÝîµepÔÖ/W¨¥j~ªêãNh%êGoÔÈÓ×ïIrÇZì¦ùÓ»î§ø1®¡¢?]nuä§¤§³¹óÃhÊh½î¥g7Rdí]\\¿Æ6UTÉCLo!}yöuV;fxÕxêëæÙVS<I2õ%91XúÅÇ}Ñ&æ-Uß&=@ª!=M	nV­}Qp4¨ÄPÞ5+ø÷TÑF¿âðèqÇ´øu&îþQy)Ðî¾\`V£ß!¹O¨Y¹óÓö^$5hÕ¢øíQ}óyy-ä¡¡fËUT&DðµÿÁôsfÿ=@aT÷O0!,°£¯ÉîÓ¹¥Ù&m³åA=J$ÃK$±+'Ñ¨© a³%BØÐ!Ú^v(ã7o75DQ]H°¯e¸g]U	ð¾ó(Pt¦¦Cu¹s&s;íM[9åY»¢Ýì°Å=M´(hÇî^ß»ößG<éóúÒ¶ñö1OØùÚ×Ùâ]<yèC=JýA¡Ùsfkª)¯!XHs¦Äø$Â)ÂNhÚÞÕSçñÝ§Ð]æ76Ößý{­\\°w_UET@GÞbÍÜî©Yâv^9 Á"ë¼@!Í¿9ÀâyXmØE)÷´=@)Ø)ÁrÆ ù£7}Îîy>[>äàë«<)÷:ÕNÈöÝ¤ <iþ©ß&õ#5NèøZÙ=JóÚ³ÕOhþï|!ï=}Mà!\\æS_Êø§<yXãº=@ÜYyAÞ64W)÷³ÎHÙDâÙ<Éó\\üþE·hµyè#\\ÉÕâµí!égÔvï½ÙðàÈ#hà¬¶¦©oç×Ohÿ<f­ªîy¾]âéçC=@åãîcßúì¾È%ds&æ¹"Uµ§mO¨úïzõ%uæÁºÃzØÌ27¡à"Éá³(ÜîÙÝÎ1 YØî=MDµæÞ¤eívÙåpÀ¢Ê´ÌD(bê$Íðáyr¦{õ¸Ä¸WÁ»â¹ÅrÃÕÛét¦]õ.é¿"*õ¸oX YÎéÂ¯¦ø<¦Òs=}¥!¡?OÕÒoéÜ÷¯Áè<ÉûÂ$uF-txZ Ü5ûétÿÇz)ã°eÆ{ {zi³Qev4µHRh0.æ¢ÖîE¢Öuã¨§°î#7ÑùgL\`Vä×û9°'Ò¿ÁýïDþ|§¡×kib6Á\\höÛ6	Öhiü%Ë©CuX#sE¿^ 7H;!|à	ø? ¦o³=M­à7¿â5íïº#ÇT¾"£auÓ_ÙRðÿWÁbæÞ×î-ÄCLµù²O¿6fa%_·»¢áJmëçaXã9Á"_yuö«FÑÞÞÚä§UCe^õòå	þA­æUÜuüÌK³IÝþÉd£³ùâØ>7t8iæÖtÛï7YQåtEa­ý¡æÆN8ÇëáíUs&®½ÝóÜC_^û|^'÷P·NÈ&JþþöNõí\\Õpñ{(çOÈ	Zßä«'OØÙCèÜÃ¸Mß&¡,$ù=Mµ<I{ðþIQëÁ@Óëyþ£ûý&=JQ¹½(ïÆ¨=}'±l=}~edÎ×y&¥Õ¤ÿµÔÎÆã¥Ó&ÃÍ	Ì.c4õ{V¿Óh±yL|nâð¶QN=}@;ü"CçÈ8¨LY©F(Ü¶\`ÜÆéRu¾í\\¬ð¢Ó£g(&k¥©¾Äöå(=M&kTeþÜ=}}/l3s%©ÿ0ßÖÊç¿GÐ@$!Ô©·Z1I°q dÛg®´.´~%Ô\\©£JìF@¸rB.ô&æÜyAÉ« |Ñ5Éç§0 CÒºn¢Â·»-KkK:þ>÷mÄÊzÕ~¯±c[Tô=}K[3Ðä$[»PÝhVøBüåpo~û±onooÂí³Û$+;3§CÂÒI´µ[ï]XXP.½ãåZ§)n>EÐa¶8µÓÕ¹]O):ÀþexIG=}ô(:;þÚÇhøÂ</'Ë4û²­<v©8ÄÈ?ØÀ>í4Âª;·wc:_ÆóÎ9µ³µ\`Prü=MM0USÌM=MoYâ°ÔMö$;3NR>Á>=};QÜ¡ÅÀwÖ9_oC¿8³ÒÑ¹_°°´Ì.ÐÏ5·;Kd/Ó§FØc³Õ=@¼o=}%Ä¶Ã3Ðh3ÐúV|í÷[ÌB»àÜáÓ¹[[Î¹3ýáýþá¤·È÷Å°ÞAÝ§± ëk×0±^úý/Ò'"YÀÊ en¶èÓÊ«^$þÒE@9mÅòNÛ§MÌv©xÁÙÝ[øÖ6í²§Éèpb1qn¦¬ÍÅ=JÐ$N}¦n¶ã´ÈG´ÕÌZ´§½bÍÃ6FÉÓ3P'éR	RqOË§nÖS~¶\`]nÂ=}=}ÔsDïNp»}v¤ÍèÕ\`¤~îç[xN:Áv:öü=Mv[$[³zJ§l6#Xþþ8ÿqonqÁA\` ÎúB?OC_hUÜvvf]n´_ünr,ßùEC÷Â.¯ÌMöPçº©·(Þ{{Ð¾dlÌµæÅÓ&]úÿñiÊÈ\\<=}@@t1noþ¤Ï£=MDsè$.¢¸_$z¬{\\±/aÍ":AÆv\\pn»n½ÑÄX^{ntJÉiúûÄgÕ^=}ªT$no\`Ãc²4iï´+µ?oå°mE¿úKºró¸Ào÷´»¸>ÞO_=JìMö¬H¼ù¹:\\p4ÐýÅ1îÂ=}0=}pîÏþdNñ²~òó´laNÄ/5®|)ïÃ~ô·6ûµËLÅZp zlÆÛyÎm}Z{;ÿî9¶ôÝtÃöò×w3¾*çÙÕU_¢=Jë­P}ÎrIwOoÐ_Oû.R3ÿOc°ÄMìoWÍT®$7·25Mu³ØØØÔ=Jß2{b·´ÔÂ&õÏÄi«@²	K"=}¨üHà{s÷4%SS¡æFÄÈú¦A 8¼_MVTò-¶¼;ì¨O>>uH\\ÅL$!ÑÈí]ÈÞã ÷¥3l¬5ëÇz­zÅJ^K®:;ä<¤:¤=}L2û®ìì¦¬[[KpÕÐR«S8;_&':{}óµ@ÿÔAþF<]jç09vjz~lnQ}IÞI¶«(¨¨_;þØ?l¬±RA«¡¼ã¤PoÂSÓPãKµò4;ù[kâëëÛ¤Y®l\\¦-DFÖ£ïÓÃy'(+hr¢YÇ®á®a<¨A13Ù2Y3ù3ù2y2¹3¹293!2¡2a33C®µ®®ý®=M®M®'®®~ì@ì¹®ÿ®353Ý3ý3½2Í3m3³®lBËQË]Ë7Ëckæ7IjM":T=}2X®®Ü®\\<îÝÈz»=JSý%=}D;=}¤:ö®»®231Nw¬]U³CgK°Z±Ú¹¬=JpxÂxblòõîë®Y3128ãcz®®Õ.9©ì lEÊO0LËæWÃ¼ÚÂ¿z¼æIlBkobs¢lÚÑ¾Pâ<3¤¬\\.;ënRqbìÌ2ÀiÀ*lNhöà¾LE}¶<·ö¿¶´vÛ·6[­6;tL]KMöKM^¨ßQM¶¥ßJ]#÷sât²©ß	áÁ	¼S	H %ES\\ñ=MÕU[\\óïõëuF1ìBGK,õQ¾Nb<¦3­292=MC	È[	jiílÙ×HV¯Þ§ò¶¸}-à,êàQW/É¼@Õ#«÷~kÇ«Ïãåo7¯e£ÿãäñclxâð/-øWcbð«NÔÔâÎÃ'Æò(GôèG÷SïN¸4Ú¬öÈ²öªýd¸yª×¯Åsê¾íF½½êî)6Ú<§TËñWK]?§5Ý\\Vá8 dòÙmßìdVÔí¥GÁþCG8¾ý=}£÷B{±è¿¢lRôcý×§ÊçôAËè¾ê3=M,T¶[1±6£·6BÃ¶*§­¤¦mÑØìó ¦íJyG=JdúO%P©õñ¸Hs2'd}%Ô]x/.ÃúqÃ»>ÿ÷éL¸RvfbÆµÍnóÏê@F1¥[åÌO¢l²Gë-1=J=JNÜ'C¬à\\¸	ê#ÍC4díEÃHÉU¦ô~'Kù¶­©ùCð÷bîÌÛ©°Ê×¶%¥BMý=M8õ©ÿJy\`Eõ·9=@f¢m¦ßïàÎÿHdh\\GÊ¥ÉIä	5j!ÎJ4kÁÂmiO©$«sýiø	#)!Ï$ý#)¸))IY¾À@)=J©Éé)×©(¸)üi)Øè<"éìUÄø"é÷ÉÝih¿)©¤&	'!É]¨)Ôè>ég)©$"þ¡L(&I=M¯ãÄ=Jó_Û=@·¡è¹ÝXªUâôì[A¢"V¨©öÉÇÍ6=JtÂÉeÑØÁ ®?eÁðD ¨(ÿHõ¬ñÀõ%ÐF<ámV!3:ïö²?p[PÁ?þnJÊEöBµïµ	â!sáj¦S±©àà  #AXÌ¶µéÀ5nOÂý±Y~=MåÛI;ÒÅW\\kq¡$¹ß£Ëd,â*/'â}'W 8´¼þPA X=M{ÿù¹ßjFèø$=}~û7=@Ý¯µýÌÉÌ÷¹ãK6íHúoü¦«^µ\`¯Þ'E¡2U[í-HêájpÚß|XB±=Mq_ß0j,P/8ÜAõPx[YÓ|3}u¾ûå×CúâØÉÅI¥ÎA«UÎÜ¼m\`ØÊSçÁBy@±FÝgâ1un=@PÄÍ\`q|Ö÷YÚsu8é2Ì¢pe%íÉÍP}±×®èô)=@À¼oÅc¹éÐiÍ\`·É~Ø¹ìBÈör=M¢¿WýÁ#H¹©Øäã,/\\¨yÓóíñékõãîÉb!í{¾÷._GÙä¾*eeëºOô~d\\ÙÌîDÏÕ>VÛQ>³âÕkÈìËÓ×···×w8aõÅaYreeEU©#G¦\`1#5á±WmC²6ª¨¥qÀàCFô×ý´ãóM¨ùzª$ù(w¥¤ÔæY¼!=}ØïÍÈ²½!£YV¹WY¼¡H­}Î}¼¹b;½ÍfI3ü§âKòA¡ûJAMlÇ´åPAe³JdØÈµ?¡Og}y¿¦æµØA¡1£ØÞm:´md:^OF,Z ÁÿeAÕ2T\`1ï	}çÀ2¡õGë4H)Sìår?¬¯¾©(AÓ4õkóÙ=JÚOÐØèSáíþÎ_z»ÄÁh¶ÿ¾ë·NâRÂMa]ï{ oXaóÈ~­cT\\àd#|õ{ÕAyÌ+dð²<þ&eÖåâ7«z¹=JatSG;ö"8ùW¨è®ã|eÛ]Ö=@à6ßË\`CË;òX	Ó	×=@JÈ¦ütôMMúM~t$>gåâ«á¹Å¤?äÞr5=}ö ²ûLÓG±gåw_ûr3í@¼<W4|lÚÆ	èÀ=}áX}XÜGIA{ü÷·ïÇqG×WëÒïÞÌ¡dÚ/LvÞrÞñsëTçýrK³çMðqÞlÞsWuÞÑRmÞÀ&Ã^ýðÞFáZ9=}ËümLï*®]o<dU=}ÅTy3î=}½«ñÍ³<X$Ý9Ñ^älS^Û6w:>´¨ß¶¢Ö Q1ax¿Qh§B³|¢Î7nÙ§v©Hsé2ºïG=MKpm÷¨I'ôäÆF=@¤ÅF%[³tc¬ kcáû{àÞ=}nIÒ=MIöh:þHæñ;n9~@²~¨ti3¤îBÎô¥ç¿^~eøtxkåB§Ös±tåzDç¬$Æ&Ò|ØÀÔ/Oé=J*¿$Æ&bïdÉÑ?_ÓAQS¨-P/nôÿÛrtÿ\`îÛI.çïÝñzUÞs )^P¼kVDÇÁ>|J"jE5QÊàwrjO°2s~_¾ÊúW$mwýªF=JMjòÌB£Wx*a(ÜbJ¡Ð§ÐðöÃ_Ö=@S¾¯M|@îòÔã\\!¨êMÃ[ØT_)°=MîØÁ¾¯¡"Ã"ìdZp÷)@ñ++@T£	úÞWândÿ¡°FO&ª/tév2$´Ù?LÛßrIëU5GYÚ¥óâ#âÊîçîÚmàÔ_a'ï'Z'¶ÓyÂlËÖáDÈS$F¯IIìA×®8íc¤hÄnIîYÆkõÄZ9Õ¢W¹ÑâùÈ<W¦l¦eU#ûñ[2~¨­ù£PðW±è°H6cµËt¸-o<àt¸d­ãîüAb6âî;û¤^°êÅÑzS©5Éi+1;a1­»È_õ[5ÉÎ<}*QÂL§iw8ßpQ-K´ÚgØa,ô=JVÓÊÈñjÂ\`§fÕ_·Ú³ÝDß°BniðrBùÃ®Ää\\Û;ë|ìj¶}c­ù-REÂtW·I¿äF¢¸Â±bba}Au²¡ïvçÉUþûT¯¾F#úÁÏ¬Û¸Ù¿úde×=@YSçyÎRl¸'¿@¶&I£æwsvì×÷é´~_=}®VÜÿd´Hc4·M}->âº"¸þ %Y×§.=@«$+ÿ,¶ÝG®äÀÜÉ2ÊhËM®Õ47JÎé¼¼ÝK[ïD²\\_'Á+ï½¢eIåo\\Eøù¦½Æ¼é{Û,Ä7Þ[|¯Ö=J1·£ùE9=}{¯þ×i=MC½«î	|=@/ º|Y^ììVÈùÀ%Æ\\éjè¹;î×<¥»üßðRDËºlÕP%h¿]5HZì¦Sí³ïDc±S)¨+}ú£¤+K#ùS#?wYìÊDíÈ;öÆ²:KùábNNjà~5ß°=J@g½c¹Ü-;×î)l£AÄÅöû;ab)<ÍÇù/£|ÈqÁÀq¡zFUv6U·óÀ©KÑÜÓaGÜ6E¬WtQ?7J¥IP¸?óºç²~ü2SÉÍr*_®-­ÛÆ"\\oÔG¢mÒl7²HÄp=M+Hõë¯ðþQcéH©Í<]µ]K#Ä8Êªüæ(ryÊÀQ¯«tØfôÜNÕï\\)ÛÞYÌæÕS®Þ5w|qËoÍ/2×ÓÑ|¢ÇxRsÓ® ©dk·=J£pÕß.ptf«}HÕ_Ãäl¹=@ÓÀ-%U¡''3l9Òjç²åº$ïq´Õªº§ÿ$À¯	}Àÿr¨/3ÓYpjGsK!ÄòèÇ($iì(òÞøÛÌ(BÃvweÙÎgxßìeÏù3""tà.Wßº<^h³Á¾iK§ùcdÔ·Ö9'ÕÈÉúGÔÑJ^´DHú¸Õ$;HTÎ@;!õþDir<¨ì~ì±}9Þ@OÜ/ÿÒeô]}FNxjf?q»#D~T z×ãpRíá´±TìíçW_ªÉj¢.û®Zy;è·ÜYN¿¿tù7@twà\`"5&{×ãdjìøAº#¯WA\\|³#³ÀiJõØÿùÐ¶rãV$:Q¿à3EXNâÖV7Õ_û9>÷Úþ´H#6Å¾Ä%Cªa¦9'azÿ@üYVæ²·=JÔÐÿ,uCV{ÌUvAVlÍPÿ+[*]ØÆÁ¯}q²üuÛfËI~%Y«ú.I)N²¼tË3Ð¯s®¸Ë0z)§ÞÍ¾ÐQUËf·¾=@¸djö%nc´J¦¨K)¦y¢*ïÝ&k=}2WGÊtæú,³ªT)Fú³hê$hÙ©ô1ò)Ýßªà\`Êø©(»'axÌÿé%ys(ïáòÕº¥wðéÌÿ=@N½£ÿPõÖÙ¢ìý@Ï25È  Ø~ãºÆuÒHïù¼%®p:¼Ùª:Ý4Ûl×ß|¢:ÔÊ$7³3©k·g,[¡âQ§­5è«?x=@(®ÿt<È¬dMzÓ;\\ª/?=}Ý¬m¶)¬üÙ¸ýÕÓ¢Ä¨ª-²¥255ö^4f¶vÇÊ-ÿ=}zÙ)¯©gÕ(éê^9êAÈé'/ <É)óù²/Pf¦ikÓ7ºOÎ}²#kàÙ$-Æ%g¼Ï2ÅÙ¦ßa®¹zyséÈ5±Ï¾ûî>l(oJø\`î§;Ä¾ë·þSX&¬7Ü÷U:­Ò5ÜW?¶Ò3h 1þÆ	{IÒäjÿ-pKÎ¨aáÞÈ=}Ù© ¯1J¦%©'gÜ¤x¢"Ô=@ÿ?9ÿ3©!¢Ï.[-²õD[yò ,þß8[ï¶$Ijß%ñ©ïäÏÔ8:kì$©æLÎ×&>½F#Óÿ9(Ñôéä ÛaÖ¤cú´£kí¯$TP»¹ÍØJ²1tæ@|á/D1±ÂssôãØú¼qÏô$­Ürz±®Q.Éldî4=J;H=J·bQîÉ:©lAJ@Ñqé¶ðKæ!ìóøòÒ#<çYÏKøvO\`lÉàÃ_àB!ËØã<xß²à)ÊTôÎÆîíÜÃ&Û6/XñõÍú¢q¦¥©6\`ãïL¢y&\\ç8¹Ø­þëÎÈ=Jð¬	õí?õlÝzÎ\`3ûÍ¦âI¹âÍsW:I9¤å¥Lif*íºÑ¢QY|wîåò1R)yÂ,ÉÇZ§=}fG3§"çÂµÅUõ5=M¿è­YÂÚÒyvúAó×¹ï'5F®mU[pYnxxmóçwVfG !XÍYvtµèk=MCR#Nè9Þ«wU6Ù¹gÿ U[Öd6RA#B5©),ßôï²±6Ç+'T7ï"¢9ª}çpiüuøñç¥zÏ?©"¯ÚPâ	E ùo7èÜþzh5ßeÈïãê|â.Oçq¦YîÈ·hm©ñ=JÇ{XüÄ¡lçX#B©~Ô¢.évFªGTç´¢ÄÙ^t(¦?5§×2U9dEÛ}6IHXÐWÒ¨,¯ñ¥¹KôùHgÉ«¿|4ØöuëSA9¢¶ç±E)Úå¶í¸Ê¢EfYåFOØqÿÌ_[Ûapaýþå¨.ô©°WDË"Öôb¹I¤\`ni=MùòÛ>Ñ¬Ü"¦ê2V]DðªÂBi:P¡möc5æÁëµqZâ8qñíëb¦ë9HUx¹4F97jHá\\9¥åïë§·ûí¨£cø^5ùÆÈÏ¦¹]¸L 	z^O¨§Ä¶·¡ý=J¡9¦]-å%1ÌÔ'pb.iñ¢ñÛi.aYný¾gB|çD¡¶p²æHèqèëJ@2D-YØxêçCÝ=MøBöÏá!R<g¥$ñ±¬\`¡=}ìÁpË©mv{G5ÇàLàgÐ"älG¨Ï6"ÍQ"öØYÔ&=@/wwmìÚ&|3Ù±W­ãF@diðþCõÚ$UÆ	@ñg­¨ 7æ&b\`µ¶êÈúMaèÆZ,G£Ì DÌùApÿûçLl$Ék1]F¡í.´¯Ç¯¥#»Ñ7\`ÿå®1s%Zw^¹F°Üw®Q I­ßïd·¨B©,Ôî¯x6òe-ù§"È"¥¡fé,¥ÄMÄ+Ý\\ps'^=M-4¶Ç6	ÊUrÓ]ICÛ½{¦õ×1Ñ¿£Lu(Äik¿¬l!"­%6(ý4Ë³N(3ðMeì\`>ëÓ£úfûG9©¤¯uXeºÙTvÕ°úûhÿjëCÏúàT¾Ü1H'ªùF;çÑ?æ1©µÞxÝºå(i£¯ô7PM¡8ôµ&¤QÆy¸ÁS¥Û©2c&gÀh°eU'Úd0\\D oóhº^#[$x±!Á=M±=MÔ½Y"ª&XLÞBH«Ñó1Çel}=@¨àK¢¦§?Õ½§:\`#?FìAâ@°·uûãe¹º°!{|þÒâCy¿lý4Æ'gFAl!«ñzw<°vô­3ï=MÚ©¥îÂ=JmµX¥5¯qü=MbÃÕV¨¦·ó M§*¶ ;Ù¥Vì(AÎD\\¨Çµ$ÉÑî¿vezHÁ¨ì<ØÅµßéðyÇêý¥=}huH¸µ£ÁMk6$GÆGç£µa(ª3Á\\[1t´¬tÈþr¸ïÁK·ÝìMZY¶_=JVHzÈ=@Õ]°«ØBØC¦Ød=Mª¡MâDzùcÜ?åÌhúm6ÅÒÀÛ2?ÄÌá=MS%¦6·÷;DÞýËwñR¡ 5fµÌÈ5³ÜEüi´1i|qçØªÙLëÇ@#Q}Ù¥ÍÛoú©i1EAÉpßH#Úwm>ã¢.í ÈêæuåÛäâ/±A¹®éù{ß¤FG[Ì=}ùe@ïFlwú>¶£/Ai¢KüQ6Ãz=}\`ù]Û,DWæÊ(g?ä÷ðµ-]{Êÿ>Xíüøg{Ö(¹r É³Í¦oÓ©ðFä=} ¤³P¤4£M[£'Dre«àGÅËå¬ÂCÁ¸Oàº=@Ê@Y9ëß=JÍ2¦µ8IîçkBD¤/lù=MìxVÇ¿¸+øJhfã>0Ês³PÂ=}ÑVYx¹_¥Ê=MqR=}:ðç=M=J#h(FXm9M¤WQÖÐê0=@©¹Ù ¹.nØª#2¶E¬'o$¿¶é´÷±àý]µEE4J¥OHð}9QÌª}?¶V»Iííj¶¯­½íx4¨¶5ÞéR´sáÖ!¸Ñö±Udý´÷b¨ÞJFQ¢MÐw~^+¨è³:#ïT.¤§µLg¹­m5©8}o=MðTâ©6³ñéÇnÿ±z×¸;(?DÍ¯­B#hIß±øÍ'Ð[2Ã]CG¸ìÕ=MÎ)/8OékÓ×²ÂC4áçzéB{Î:gâ!qÌÔaa>Cl"þ£rÓB±´¯ÛõfÆ´àÍ!=M¦0\\ÉWGT~¬Øùùì=JúK7×ñèoQ!âg1v­)A®©§CG×ìRa©Fèe95VïÆDiã¬²Ú0ý°QB[¨cðáÆ¯aQ'zKM°¶«ñUÊëìõâÞMØQþo"í°òÆ©?Æ³KuÛ§÷¦ßB¿ñÍÞeÌÕ8?æðÍ[G0÷	ûÅI4GðèØ=}[=MÆç9¯ GñÏiÊèÛ"Ü{~B90÷j=Mb¢ßF¬TÏúÁMðåwíêª3Û!@D¬ç!êï-æ8Q9Î¬sBè(;ÀË8 \\]$J¤0øR³?È"- ¹\`ËlglIpÒhBhÞL4Õ¸YÑÌÑåÒþ8Åýî6¯uàïaÕ[Y"Pí2¨Î ¯Bç"eîg´pÇS­[tn)Fwåu¹âÀe*®ØUÉ¶ÊWd±7îQ¿y¥\`x:Ñg¼a#Æ,ÿ jdN£Q¾yáä8@Ñø¼pKGèp'fÌ;do´²áÞ¿=MEª¶nmqË¦¶ùÇ¹é71¥1°*»q6dã¿éÃÁMmh»kF<óï6t«t°Ês8&ÂÊæe³~ôãeÑú]=M ³^/ÐrMø±;Aµ¡í¿aîC?¢ìü Çmcìâ=@bÿã3Ù&AµF£nQ9=}?þZsú0MkÇ¾!¿µü¯ ð×Ëà E=Mh"]G_#ÿ Ù=}þÚ{=M=JPfÕL¸kµÍþø^x\`ü¢4P·ýÈ^ DÕsöÄpìürzDEùºð(v=}ý´´¹Ì;Æ2¦_×b«ÉàsUs=JKÐ^È¨vUm=J%f/Ãðaï\`¾ø$ý©dy'ÖiÇÑÝ(=@Éø$ý©dy'Ñ©dÕ#¡ºÉ#]©¨ù©z#Ã)Éb=@¾ñð\`ÙÇç6òºéjël¯µb@Wænó|Ïõ¾WëoæÌ'yî)a)³InöÅ´0xPVj#@Ù ¯â¯=MXP~¦ÿºÇÇÑÙðúÊKN©]Eâ(üp¦¼Ò@ËiK|VÇÜµï-F\`oYIiS¼²;ù$¾ ÄzÈb±À«2d¼ÐÚº¥·$fî3c>ÖwèÈÙ<òa~~i³nèÜ5	À»¡â:Î´âbou({à!#^Ñ'&jÜf6õýáIÏA©)v¤è×Î¡ÏAÉ<£ÄÁ5à#O³Ö#t ©(é½0k!zÀç#(dé÷ýîì=M2þ#Ù_6û÷=JGæÒMH¾æº%Çà)1`, new Uint8Array(107390));

  var UTF8Decoder = new TextDecoder("utf8");

  function UTF8ArrayToString(heap, idx, maxBytesToRead) {
   var endIdx = idx + maxBytesToRead;
   var endPtr = idx;
   while (heap[endPtr] && !(endPtr >= endIdx)) ++endPtr;
   return UTF8Decoder.decode(heap.subarray ? heap.subarray(idx, endPtr) : new Uint8Array(heap.slice(idx, endPtr)));
  }

  function UTF8ToString(ptr, maxBytesToRead) {
   if (!ptr) return "";
   var maxPtr = ptr + maxBytesToRead;
   for (var end = ptr; !(end >= maxPtr) && HEAPU8[end]; ) ++end;
   return UTF8Decoder.decode(HEAPU8.subarray(ptr, end));
  }

  var HEAP8, HEAP32, HEAPU8;

  var wasmMemory, buffer;

  function updateGlobalBufferAndViews(b) {
   buffer = b;
   HEAP8 = new Int8Array(b);
   HEAP32 = new Int32Array(b);
   HEAPU8 = new Uint8Array(b);
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

  var ENV = {};

  function getExecutableName() {
   return "./this.program";
  }

  function getEnvStrings() {
   if (!getEnvStrings.strings) {
    var lang = (typeof navigator === "object" && navigator.languages && navigator.languages[0] || "C").replace("-", "_") + ".UTF-8";
    var env = {
     "USER": "web_user",
     "LOGNAME": "web_user",
     "PATH": "/",
     "PWD": "/",
     "HOME": "/home/web_user",
     "LANG": lang,
     "_": getExecutableName()
    };
    for (var x in ENV) {
     if (ENV[x] === undefined) delete env[x]; else env[x] = ENV[x];
    }
    var strings = [];
    for (var x in env) {
     strings.push(x + "=" + env[x]);
    }
    getEnvStrings.strings = strings;
   }
   return getEnvStrings.strings;
  }

  function writeAsciiToMemory(str, buffer, dontAddNull) {
   for (var i = 0; i < str.length; ++i) {
    HEAP8[buffer++ >> 0] = str.charCodeAt(i);
   }
   if (!dontAddNull) HEAP8[buffer >> 0] = 0;
  }

  var SYSCALLS = {
   mappings: {},
   buffers: [ null, [], [] ],
   printChar: function(stream, curr) {
    var buffer = SYSCALLS.buffers[stream];
    if (curr === 0 || curr === 10) {
     (stream === 1 ? out : err)(UTF8ArrayToString(buffer, 0));
     buffer.length = 0;
    } else {
     buffer.push(curr);
    }
   },
   varargs: undefined,
   get: function() {
    SYSCALLS.varargs += 4;
    var ret = HEAP32[SYSCALLS.varargs - 4 >> 2];
    return ret;
   },
   getStr: function(ptr) {
    var ret = UTF8ToString(ptr);
    return ret;
   },
   get64: function(low, high) {
    return low;
   }
  };

  function _environ_get(__environ, environ_buf) {
   var bufSize = 0;
   getEnvStrings().forEach(function(string, i) {
    var ptr = environ_buf + bufSize;
    HEAP32[__environ + i * 4 >> 2] = ptr;
    writeAsciiToMemory(string, ptr);
    bufSize += string.length + 1;
   });
   return 0;
  }

  function _environ_sizes_get(penviron_count, penviron_buf_size) {
   var strings = getEnvStrings();
   HEAP32[penviron_count >> 2] = strings.length;
   var bufSize = 0;
   strings.forEach(function(string) {
    bufSize += string.length + 1;
   });
   HEAP32[penviron_buf_size >> 2] = bufSize;
   return 0;
  }

  function _fd_close(fd) {
   return 0;
  }

  function _fd_read(fd, iov, iovcnt, pnum) {
   var stream = SYSCALLS.getStreamFromFD(fd);
   var num = SYSCALLS.doReadv(stream, iov, iovcnt);
   HEAP32[pnum >> 2] = num;
   return 0;
  }

  function _fd_seek(fd, offset_low, offset_high, whence, newOffset) {}

  function _fd_write(fd, iov, iovcnt, pnum) {
   var num = 0;
   for (var i = 0; i < iovcnt; i++) {
    var ptr = HEAP32[iov >> 2];
    var len = HEAP32[iov + 4 >> 2];
    iov += 8;
    for (var j = 0; j < len; j++) {
     SYSCALLS.printChar(fd, HEAPU8[ptr + j]);
    }
    num += len;
   }
   HEAP32[pnum >> 2] = num;
   return 0;
  }

  var asmLibraryArg = {
   "c": _emscripten_memcpy_big,
   "d": _emscripten_resize_heap,
   "e": _environ_get,
   "f": _environ_sizes_get,
   "a": _fd_close,
   "h": _fd_read,
   "b": _fd_seek,
   "g": _fd_write
  };

  function initRuntime(asm) {
   asm["j"]();
  }

  var imports = {
   "a": asmLibraryArg
  };

  var _malloc, _free, _mpeg_frame_decoder_create, _mpeg_decode_interleaved, _mpeg_frame_decoder_destroy;

  WebAssembly.instantiate(Module["wasm"], imports).then(function(output) {
   var asm = output.instance.exports;
   _malloc = asm["k"];
   _free = asm["l"];
   _mpeg_frame_decoder_create = asm["m"];
   _mpeg_decode_interleaved = asm["n"];
   _mpeg_frame_decoder_destroy = asm["o"];
   wasmMemory = asm["i"];
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
   this._mpeg_frame_decoder_create = _mpeg_frame_decoder_create;
   this._mpeg_decode_interleaved = _mpeg_decode_interleaved;
   this._mpeg_frame_decoder_destroy = _mpeg_frame_decoder_destroy;
  });
  }}

  class MPEGDecoder {
    constructor(options = {}) {
      // injects dependencies when running as a web worker
      this._isWebWorker = this.constructor.isWebWorker;
      this._WASMAudioDecoderCommon =
        this.constructor.WASMAudioDecoderCommon || WASMAudioDecoderCommon;
      this._EmscriptenWASM = this.constructor.EmscriptenWASM || EmscriptenWASM;

      this._inputPtrSize = 2 ** 18;
      this._outputPtrSize = 1152 * 512;
      this._outputChannels = 2;

      this._ready = this._init();
    }

    // injects dependencies when running as a web worker
    async _init() {
      this._common = await this._WASMAudioDecoderCommon.initWASMAudioDecoder.bind(
        this
      )();

      this._sampleRate = 0;

      // input decoded bytes pointer
      [this._decodedBytesPtr, this._decodedBytes] =
        this._common.allocateTypedArray(1, Uint32Array);

      // sample rate
      [this._sampleRateBytePtr, this._sampleRateByte] =
        this._common.allocateTypedArray(1, Uint32Array);

      this._decoder = this._wasm._mpeg_frame_decoder_create();
    }

    get ready() {
      return this._ready;
    }

    async reset() {
      this.free();
      await this._init();
    }

    free() {
      this._wasm._mpeg_frame_decoder_destroy(this._decoder);
      this._wasm._free(this._decoder);

      this._common.free();
    }

    _decode(data, decodeInterval) {
      if (!(data instanceof Uint8Array))
        throw Error(
          `Data to decode must be Uint8Array. Instead got ${typeof data}`
        );

      this._input.set(data);
      this._decodedBytes[0] = 0;

      const samplesDecoded = this._wasm._mpeg_decode_interleaved(
        this._decoder,
        this._inputPtr,
        data.length,
        this._decodedBytesPtr,
        decodeInterval,
        this._outputPtr,
        this._outputPtrSize,
        this._sampleRateBytePtr
      );

      this._sampleRate = this._sampleRateByte[0];

      return this._WASMAudioDecoderCommon.getDecodedAudio(
        [
          this._output.slice(0, samplesDecoded),
          this._output.slice(
            this._outputPtrSize,
            this._outputPtrSize + samplesDecoded
          ),
        ],
        samplesDecoded,
        this._sampleRate
      );
    }

    decode(data) {
      let left = [],
        right = [],
        samples = 0;

      for (
        let offset = 0;
        offset < data.length;
        offset += this._decodedBytes[0]
      ) {
        const { channelData, samplesDecoded } = this._decode(
          data.subarray(offset, offset + this._inputPtrSize),
          48
        );

        left.push(channelData[0]);
        right.push(channelData[1]);
        samples += samplesDecoded;
      }

      return this._WASMAudioDecoderCommon.getDecodedAudioConcat(
        [left, right],
        samples,
        this._sampleRate
      );
    }

    decodeFrame(mpegFrame) {
      return this._decode(mpegFrame, mpegFrame.length);
    }

    decodeFrames(mpegFrames) {
      let left = [],
        right = [],
        samples = 0;

      for (const frame of mpegFrames) {
        const { channelData, samplesDecoded } = this.decodeFrame(frame);

        left.push(channelData[0]);
        right.push(channelData[1]);
        samples += samplesDecoded;
      }

      return this._WASMAudioDecoderCommon.getDecodedAudioConcat(
        [left, right],
        samples,
        this._sampleRate
      );
    }
  }

  class MPEGDecoderWebWorker extends WASMAudioDecoderWorker {
    constructor(options) {
      super(options, MPEGDecoder, EmscriptenWASM);
    }

    async decode(data) {
      return this._postToDecoder("decode", data);
    }

    async decodeFrame(data) {
      return this._postToDecoder("decodeFrame", data);
    }

    async decodeFrames(data) {
      return this._postToDecoder("decodeFrames", data);
    }
  }

  exports.MPEGDecoder = MPEGDecoder;
  exports.MPEGDecoderWebWorker = MPEGDecoderWebWorker;

  Object.defineProperty(exports, '__esModule', { value: true });

}));
