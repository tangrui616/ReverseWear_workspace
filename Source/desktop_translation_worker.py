"""Local-only JSON-lines inference process for the ReverseWear desktop app."""

import argparse
import json
import pathlib
import socket
import subprocess
import sys
import tempfile


def available(name):
    try:
        __import__(name)
        return True
    except Exception:
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', required=True)
    parser.add_argument('--argos', required=True)
    parser.add_argument('--packages', required=True)
    parser.add_argument('--llama', required=True)
    args = parser.parse_args()
    original_socket_connect = socket.socket.connect
    original_socket_connect_ex = socket.socket.connect_ex
    original_socket_create_connection = socket.create_connection
    original_getaddrinfo = socket.getaddrinfo

    def deny_network_connect(connection, address):
        if connection.family in (socket.AF_INET, socket.AF_INET6):
            raise RuntimeError('本地翻译进程禁止联网。')
        return original_socket_connect(connection, address)

    def deny_network_create_connection(address, *args, **kwargs):
        raise RuntimeError('本地翻译进程禁止联网。')

    def deny_network_connect_ex(connection, address):
        if connection.family in (socket.AF_INET, socket.AF_INET6):
            raise RuntimeError('本地翻译进程禁止联网。')
        return original_socket_connect_ex(connection, address)

    def deny_network_name_lookup(host, *args, **kwargs):
        if host not in (None, '', 'localhost'):
            raise RuntimeError('本地翻译进程禁止联网。')
        return original_getaddrinfo(host, *args, **kwargs)

    socket.socket.connect = deny_network_connect
    socket.socket.connect_ex = deny_network_connect_ex
    socket.create_connection = deny_network_create_connection
    socket.getaddrinfo = deny_network_name_lookup
    models = pathlib.Path(args.models)
    argos = pathlib.Path(args.argos)
    llama_executable = pathlib.Path(args.llama)
    cache = {}
    active_key = None
    opus_runtime_error = None

    def select_model(key):
        nonlocal active_key
        if active_key != key:
            cache.clear()
            active_key = key

    def status():
        nonlocal opus_runtime_error
        has_ct2 = available('ctranslate2') and available('sentencepiece')
        try:
            import torch
            from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
            has_transformers = True
            opus_runtime_error = None
        except Exception as error:
            has_transformers = False
            opus_runtime_error = str(error)
        has_llama = llama_executable.is_file()
        argos_models = {
            'en-zh': argos / 'en-zh' / 'model',
            'zh-en': argos / 'zh-en' / 'model',
        }
        opus_models = {
            'en-zh': models / 'opus-mt-en-zh',
            'zh-en': models / 'opus-mt-zh-en',
        }
        result = []
        for direction in ('en-zh', 'zh-en'):
            argos_ready = has_ct2 and argos_models[direction].is_dir()
            opus_ready = has_transformers and (opus_models[direction] / 'pytorch_model.bin').is_file()
            result.append({'id': 'argos', 'direction': direction, 'available': argos_ready,
                           'reason': '' if argos_ready else ('缺少模型文件' if not argos_models[direction].is_dir() else '本地运行依赖尚未准备')})
            result.append({'id': 'opus', 'direction': direction, 'available': opus_ready,
                           'reason': '' if opus_ready else ('缺少模型文件' if not (opus_models[direction] / 'pytorch_model.bin').is_file() else '本地 OPUS 运行依赖未就绪：' + str(opus_runtime_error or '缺少依赖'))})
        gguf_file = models / 'Hy-MT2-1.8B-Q4_K_M.gguf'
        for direction in ('en-zh', 'zh-en'):
            result.append({'id': 'hy-mt2', 'direction': direction, 'available': has_llama and gguf_file.is_file(),
                           'reason': '' if has_llama and gguf_file.is_file() else ('缺少 GGUF 模型文件' if not gguf_file.is_file() else '本地 llama.cpp 运行依赖尚未准备')})
        return {'engines': result, 'localOnly': True}

    def load_argos(direction):
        key = ('argos', direction)
        if key in cache:
            return cache[key]
        select_model(key)
        import ctranslate2
        import sentencepiece
        model_directory = argos / direction / 'model'
        tokenizer_path = argos / direction / 'sentencepiece.model'
        if not model_directory.is_dir() or not tokenizer_path.is_file():
            raise RuntimeError('Argos 本地模型文件不完整。')
        config = json.loads((model_directory / 'config.json').read_text(encoding='utf-8'))
        tokenizer = sentencepiece.SentencePieceProcessor(model_file=str(tokenizer_path))
        translator = ctranslate2.Translator(str(model_directory), device='cpu', inter_threads=1, intra_threads=4)
        cache[key] = (translator, tokenizer, config)
        return cache[key]

    def translate_argos(text, direction):
        translator, tokenizer, config = load_argos(direction)
        tokens = tokenizer.encode(text, out_type=str)
        if direction == 'en-zh':
            target_tag = config.get('bos_token', '>>cmn_Hans<<')
            if target_tag not in tokens:
                tokens.insert(0, target_tag)
        if config.get('add_source_bos'):
            tokens.insert(0, '<s>')
        if config.get('add_source_eos'):
            tokens.append('</s>')
        if len(tokens) > 1024:
            raise RuntimeError('文本超过本地模型单次输入上限，请分段后再翻译。')
        result = translator.translate_batch([tokens], beam_size=4, max_decoding_length=512)[0]
        output = tokenizer.decode([piece for piece in result.hypotheses[0] if piece not in ('<s>', '</s>', '<pad>')])
        return ' '.join(output.replace('▁', ' ').split()).strip()

    def translate_opus(text, direction):
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
        folder = models / ('opus-mt-en-zh' if direction == 'en-zh' else 'opus-mt-zh-en')
        if not (folder / 'pytorch_model.bin').is_file():
            raise RuntimeError('指定方向的 OPUS-MT 模型文件不存在。')
        key = ('opus', direction)
        if key not in cache:
            select_model(key)
            tokenizer = AutoTokenizer.from_pretrained(str(folder), local_files_only=True)
            model = AutoModelForSeq2SeqLM.from_pretrained(str(folder), local_files_only=True)
            model.eval()
            cache[key] = (model, tokenizer)
        model, tokenizer = cache[key]
        import torch
        torch.set_num_threads(4)
        source_text = f'>>cmn_Hans<< {text}' if direction == 'en-zh' and '>>cmn_Hans<<' in tokenizer.get_vocab() else text
        with torch.inference_mode():
            inputs = tokenizer([source_text], return_tensors='pt', truncation=False)
            if inputs['input_ids'].shape[1] > 512:
                raise RuntimeError('文本超过 OPUS-MT 单次输入上限，请分段后再翻译。')
            output = model.generate(**inputs, num_beams=4, max_new_tokens=512)
        return tokenizer.batch_decode(output, skip_special_tokens=True)[0].strip()

    def translate_gguf(text, direction):
        model_file = models / 'Hy-MT2-1.8B-Q4_K_M.gguf'
        if not model_file.is_file():
            raise RuntimeError('Hy-MT2 GGUF 模型文件不存在。')
        source, target = ('English', 'Chinese') if direction == 'en-zh' else ('Chinese', 'English')
        prompt = f'Translate the following segment into {target}, without additional explanation：\n{text}'
        request_directory = pathlib.Path(args.packages).parent / 'requests'
        request_directory.mkdir(parents=True, exist_ok=True)
        request_file = None
        try:
            with tempfile.NamedTemporaryFile('w', encoding='utf-8', suffix='.txt', prefix='translation-', dir=request_directory, delete=False) as file:
                file.write(prompt)
                request_file = pathlib.Path(file.name)
            command = [str(llama_executable), '--offline', '--model', str(model_file), '--jinja', '--single-turn',
                       '--simple-io', '--no-display-prompt', '--color', 'off', '-c', '4096', '-n', '1024',
                       '--temp', '0', '--file', str(request_file)]
            flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
            result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace',
                                    creationflags=flags, timeout=300, check=False)
            if result.returncode != 0:
                detail = result.stderr[-1500:].strip()
                raise RuntimeError('Hy-MT2 本地推理失败。' + (f' {detail}' if detail else ''))
            output = result.stdout.split('[end of text]', 1)[0].strip()
            if not output:
                raise RuntimeError('Hy-MT2 未返回译文。')
            return output
        finally:
            if request_file is not None:
                request_file.unlink(missing_ok=True)

    def dispatch(message):
        operation = message.get('operation')
        if operation == 'status':
            return status()
        if operation != 'translate':
            raise RuntimeError('未知操作。')
        direction = message.get('direction')
        if direction not in ('en-zh', 'zh-en'):
            raise RuntimeError('翻译方向应为 en-zh 或 zh-en。')
        text = str(message.get('text', '')).strip()
        if not text:
            raise RuntimeError('请输入需要翻译的内容。')
        if len(text) > 12000:
            raise RuntimeError('单次翻译最多支持 12,000 个字符。')
        engine = message.get('engine', 'argos')
        engines = {'argos': translate_argos, 'opus': translate_opus, 'hy-mt2': translate_gguf}
        if engine not in engines:
            raise RuntimeError('所选翻译引擎不可用。')
        entries = [item for item in status()['engines'] if item['id'] == engine and item['direction'] == direction]
        if not entries or not entries[0]['available']:
            raise RuntimeError(entries[0]['reason'] if entries else '所选翻译方向不可用。')
        return {'text': engines[engine](text, direction), 'engine': engine, 'direction': direction}

    for raw in sys.stdin:
        try:
            message = json.loads(raw)
            response = {'id': message.get('id'), 'ok': True, 'value': dispatch(message)}
        except Exception as error:
            response = {'id': locals().get('message', {}).get('id'), 'ok': False, 'error': str(error)}
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + '\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
