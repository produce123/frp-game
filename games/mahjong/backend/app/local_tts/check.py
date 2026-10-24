"""安全检查独立单机 TTS 网关；不输出任何凭据。"""

import argparse
import asyncio
from pathlib import Path

from app.local_tts.service import LocalTtsGatewayService
from app.tts.config import DEFAULT_CONFIG_FILE, TTS_STYLES, load_tts_config


async def _main(config_file: Path, voice_key: str, style: str) -> int:
    service = LocalTtsGatewayService(load_tts_config(config_file))
    try:
        print(f'Local TTS available={service.available}')
        print(f'Local TTS profile voiceKey={voice_key} style={style}')
        audio = await service.ensure_audio('单机语音链路测试。', voice_key, style)
        if audio is None:
            print('Local TTS failed')
            return 1
        print(
            f'Local TTS success provider={audio.provider} cacheKey={audio.cache_key} '
            f'bytes={audio.size_bytes} cached={audio.cached}')
        return 0
    finally:
        await service.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='检查独立单机 TTS 网关')
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG_FILE)
    parser.add_argument('--voice-key', default='deepseek')
    parser.add_argument('--style', choices=TTS_STYLES, default='稳健')
    args = parser.parse_args()
    raise SystemExit(asyncio.run(_main(args.config, args.voice_key, args.style)))
