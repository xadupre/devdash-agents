"""Download only the small, pinned upstream fixture used by native packaging CI."""
import hashlib
import json
from pathlib import Path
import shutil
import urllib.request


CHAT_TEMPLATE = (
    "{% for message in messages %}"
    "{{ message['role'] }}: {{ message['content'] }}\n"
    "{% endfor %}"
    "{% if add_generation_prompt %}assistant: {% endif %}"
)

FILES = {
    "genai_config.json": "dab15252ce3cdd37d5967abe409ad782c2eb8316f2ddf9f07c6aeec7f38d5620",
    "past.onnx": "f618eca0cd9025bb2b834ffa21ba3755f1313e857ddd42601d8ab922016e791d",
    "tokenizer.json": "337da36be7a71a6e88aa9148967a7bc8736f4b47c7de8e19ba92b89e80734cfc",
    "tokenizer_config.json": "514a6662da201b324a0c2abebb973a7f9515612a8328353d99c09d7ebcd2da2f",
    "vocab.json": "3ba3c3109ff33976c4bd966589c11ee14fcaa1f4c9e5e154c2ed7f99d80709e7",
}
ENGINE_FILES = {
    "genai_config.json": "171028655fe5df3811abff3c8b15dd11c5b4b4f2eb8b85fa825da1df405f4cd3",
    "decoder.onnx": "f867d6b4e5adb0cfe549e0bad346b8eb12ff397f123797771a7092bfcbb3936f",
    "tokenizer.json": "2b407086f7c94e58e17fc2cdf676aeb89aa6331f11d19b3617f817d2ede31fb0",
    "tokenizer_config.json": "7b8f96263d46084779ee664e5e170ccde4c914effd6d860e9d6aaa238a5a0019",
}


def fetch_files(directory, base, files):
    directory.mkdir(parents=True, exist_ok=True)
    for name, checksum in files.items():
        path = directory / name
        if not path.exists():
            urllib.request.urlretrieve(f"{base}/{name}", path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
            raise ValueError(f"SHA-256 mismatch for test model file: {path}")


def main():
    directory = Path(__file__).resolve().parents[2] / "build" / "native-deps" / "model"
    base = (
        "https://raw.githubusercontent.com/microsoft/onnxruntime-genai/"
        "e0e02a9d388bcc6929929241e1ec9e9c0c28c8f2/test/test_models/"
        "hf-internal-testing/tiny-random-gpt2-fp32"
    )
    fetch_files(directory, base, FILES)
    chat_directory = directory.with_name("model-chat")
    chat_directory.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        shutil.copyfile(directory / name, chat_directory / name)
    tokenizer_path = chat_directory / "tokenizer.json"
    tokenizer = json.loads(tokenizer_path.read_text(encoding="utf-8"))
    vocab = {
        token: token_id
        for token, token_id in tokenizer["model"]["vocab"].items()
        if token_id < 1000
    }
    tokenizer["model"]["vocab"] = vocab
    tokenizer["model"]["merges"] = [
        merge
        for merge in tokenizer["model"]["merges"]
        if (parts := merge.split(" ", 1))[0] in vocab
        and parts[1] in vocab
        and parts[0] + parts[1] in vocab
    ]
    tokenizer["added_tokens"] = [
        token for token in tokenizer["added_tokens"] if token["id"] < 1000
    ]
    tokenizer_path.write_text(json.dumps(tokenizer, separators=(",", ":")) + "\n", encoding="utf-8")
    vocab_path = chat_directory / "vocab.json"
    vocab_path.write_text(json.dumps(vocab, separators=(",", ":")) + "\n", encoding="utf-8")
    tokenizer_config = chat_directory / "tokenizer_config.json"
    config = json.loads(tokenizer_config.read_text(encoding="utf-8"))
    config["added_tokens_decoder"] = {
        token_id: token
        for token_id, token in config["added_tokens_decoder"].items()
        if int(token_id) < 1000
    }
    config["bos_token"] = config["eos_token"] = config["unk_token"] = "¥"
    config["chat_template"] = CHAT_TEMPLATE
    tokenizer_config.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    engine = directory.with_name("model-engine")
    fetch_files(
        engine,
        "https://raw.githubusercontent.com/microsoft/onnxruntime-genai/"
        "d01b2441a72d4e3223415b9b08474c6e65fbc028/test/models/engine/synthetic-paged",
        ENGINE_FILES,
    )
    engine_chat = engine.with_name("model-engine-chat")
    shutil.copytree(engine, engine_chat, dirs_exist_ok=True)
    tokenizer_config = engine_chat / "tokenizer_config.json"
    config = json.loads(tokenizer_config.read_text(encoding="utf-8"))
    config["chat_template"] = CHAT_TEMPLATE
    tokenizer_config.write_text(json.dumps(config) + "\n", encoding="utf-8")
    engine_config = engine_chat / "genai_config.json"
    config = json.loads(engine_config.read_text(encoding="utf-8"))
    config["model"]["context_length"] = config["search"]["max_length"] = 512
    engine_config.write_text(json.dumps(config) + "\n", encoding="utf-8")
    print(f"Verified tiny real-model fixture in {directory} and 1,000-token chat fixture in {chat_directory}")
    print(f"Verified dynamic-batching Engine fixture in {engine_chat}")


if __name__ == "__main__":
    main()
