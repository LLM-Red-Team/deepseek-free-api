import fs from 'fs-extra';

export class DeepSeekHash {
  private wasmInstance: any;
  private offset: number = 0;
  private cachedUint8Memory: Uint8Array | null = null;
  private cachedTextEncoder: TextEncoder = new TextEncoder();

  // 编码字符串到 WASM 内存
  private encodeString(
    text: string, 
    allocate: (size: number, align: number) => number, 
    reallocate?: (ptr: number, oldSize: number, newSize: number, align: number) => number
  ): number {
    // 简单情况：当没有 reallocate 函数时，直接编码整个字符串
    if (!reallocate) {
      const encoded = this.cachedTextEncoder.encode(text);
      const ptr = allocate(encoded.length, 1) >>> 0;
      const memory = this.getCachedUint8Memory();
      memory.subarray(ptr, ptr + encoded.length).set(encoded);
      this.offset = encoded.length;
      return ptr;
    }

    // 复杂情况：分两步处理 ASCII 和非 ASCII 字符
    const strLength = text.length;
    let ptr = allocate(strLength, 1) >>> 0;
    const memory = this.getCachedUint8Memory();
    let asciiLength = 0;

    // 首先尝试 ASCII 编码
    for (; asciiLength < strLength; asciiLength++) {
      const charCode = text.charCodeAt(asciiLength);
      if (charCode > 127) break;
      memory[ptr + asciiLength] = charCode;
    }

    // 如果存在非 ASCII 字符，需要重新分配空间并处理
    if (asciiLength !== strLength) {
      if (asciiLength > 0) {
        text = text.slice(asciiLength);
      }
      
      // 为非 ASCII 字符重新分配空间（每个字符最多需要 3 字节）
      ptr = reallocate(ptr, strLength, asciiLength + text.length * 3, 1) >>> 0;
      
      // 使用 encodeInto 处理剩余的非 ASCII 字符
      const result = this.cachedTextEncoder.encodeInto(
        text, 
        this.getCachedUint8Memory().subarray(ptr + asciiLength, ptr + asciiLength + text.length * 3)
      );
      asciiLength += result.written;
      
      // 最终调整内存大小
      ptr = reallocate(ptr, asciiLength + text.length * 3, asciiLength, 1) >>> 0;
    }

    this.offset = asciiLength;
    return ptr;
  }

  // 获取 WASM 内存视图
  private getCachedUint8Memory(): Uint8Array {
    if (this.cachedUint8Memory === null || this.cachedUint8Memory.byteLength === 0) {
      this.cachedUint8Memory = new Uint8Array(this.wasmInstance.memory.buffer);
    }
    return this.cachedUint8Memory;
  }

  // DeepSeekHash 计算函数
  public calculateHash(
    algorithm: string,
    challenge: string,
    salt: string,
    difficulty: number,
    expireAt: number
  ): number | undefined {
    if (algorithm !== 'DeepSeekHashV1') {
      throw new Error('Unsupported algorithm: ' + algorithm);
    }

    // 拼接前缀
    const prefix = `${salt}_${expireAt}_`;

    try {
      // 分配栈空间
      const retptr = this.wasmInstance.__wbindgen_add_to_stack_pointer(-16);

      // 获取编码后的指针和长度
      const ptr0 = this.encodeString(
        challenge,
        this.wasmInstance.__wbindgen_export_0,
        this.wasmInstance.__wbindgen_export_1
      );
      const len0 = this.offset;

      const ptr1 = this.encodeString(
        prefix,
        this.wasmInstance.__wbindgen_export_0,
        this.wasmInstance.__wbindgen_export_1
      );
      const len1 = this.offset;

      // 传入正确的长度参数
      this.wasmInstance.wasm_solve(retptr, ptr0, len0, ptr1, len1, difficulty);

      // 获取返回结果
      const dataView = new DataView(this.wasmInstance.memory.buffer);
      const status = dataView.getInt32(retptr + 0, true);
      const value = dataView.getFloat64(retptr + 8, true);

      // 如果求解失败，返回 undefined
      if (status === 0)
        return undefined;

      return value;

    } finally {
      // 释放栈空间
      this.wasmInstance.__wbindgen_add_to_stack_pointer(16);
    }
  }

  // 初始化 WASM 模块
  public async init(wasmPath: string): Promise<any> {
    const imports = { wbg: {} };
    const wasmBuffer = await fs.readFile(wasmPath);
    const { instance } = await WebAssembly.instantiate(wasmBuffer, imports);
    this.wasmInstance = instance.exports;
    return this.wasmInstance;
  }
}

// 导出类
export default DeepSeekHash;