"""安全检查 TTS 主用/降级链路；不输出任何凭据。"""

import argparse
import asyncio
from pathlib import Path

from app.tts.config import DEFAULT_CONFIG_FILE, TTS_STYLES, load_tts_config
from app.tts.service import TtsService


async def _main(config_file: Path, voice_key: str, style: str) -> int:
    config = load_tts_config(config_file)
    service = TtsService(config)
    try:
        providers = ','.join(service.available_providers) or 'none'
        print(
            f'TTS available={service.available} providers={providers} '
            f'route={"->".join(config.provider_names)}')
        if not service.available:
            return 1
        audio = await service.ensure_audio('莲花麻将语音测试。', style, voice_key)
        if audio is None:
            print('TTS failed')
            return 1
        print(
            f'TTS success provider={audio.provider} bytes={audio.size_bytes} '
            f'cached={audio.cached}')
        return 0
    finally:
        await service.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='检查 TTS 主用与百度故障降级链路')
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG_FILE)
    parser.add_argument('--voice-key', default='default')
    parser.add_argument('--style', choices=TTS_STYLES, default='稳健')
    args = parser.parse_args()
    raise SystemExit(asyncio.run(_main(args.config, args.voice_key, args.style)))
