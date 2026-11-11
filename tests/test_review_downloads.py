"""File downloads: Quart's send_file is a coroutine and takes
attachment_filename. Flask's download_name raised TypeError, so the
Sub-GHz capture, SSTV image and recordings downloads all returned 500."""

from __future__ import annotations

import ast
import pathlib
from types import SimpleNamespace

from quart import Quart

from routes import sstv, subghz

ROOT = pathlib.Path(__file__).resolve().parents[1]


def test_every_send_file_is_awaited_and_uses_quart_keywords():
    problems = []
    for path in sorted((ROOT / 'routes').glob('*.py')) + [ROOT / 'app.py']:
        tree = ast.parse(path.read_text(encoding='utf-8'))
        awaited = {id(node.value) for node in ast.walk(tree) if isinstance(node, ast.Await)}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and getattr(node.func, 'id', getattr(node.func, 'attr', None)) == 'send_file':
                where = f'{path.relative_to(ROOT)}:{node.lineno}'
                if id(node) not in awaited:
                    problems.append(f'{where} not awaited')
                if any(k.arg == 'download_name' for k in node.keywords):
                    problems.append(f'{where} uses Flask-only download_name')
    assert not problems, '\n'.join(problems)


async def test_subghz_capture_download(monkeypatch, tmp_path):
    capture = tmp_path / '433.920MHz_test.iq'
    capture.write_bytes(b'\x01\x02' * 512)
    monkeypatch.setattr(subghz, 'get_subghz_manager',
                        lambda: SimpleNamespace(get_capture_path=lambda capture_id: capture))
    app = Quart(__name__)
    app.register_blueprint(subghz.subghz_bp)

    response = await app.test_client().get('/subghz/captures/abc123/download')

    assert response.status_code == 200
    assert 'attachment' in response.headers['Content-Disposition']
    assert '433.920MHz_test.iq' in response.headers['Content-Disposition']
    assert await response.get_data() == capture.read_bytes()


async def test_sstv_image_download(monkeypatch, tmp_path):
    image = tmp_path / 'sstv_20261110_120000.png'
    image.write_bytes(b'\x89PNG\r\n\x1a\nfake')
    monkeypatch.setattr(sstv, 'get_sstv_decoder', lambda: SimpleNamespace(_output_dir=tmp_path))
    app = Quart(__name__)
    app.register_blueprint(sstv.sstv_bp)

    response = await app.test_client().get(f'/sstv/images/{image.name}/download')

    assert response.status_code == 200
    assert image.name in response.headers['Content-Disposition']
    assert await response.get_data() == image.read_bytes()
