"""Viewing the login page must not use up the login-attempt rate limit.

The limit (5 per minute per IP) counted GET requests too, so a few page
loads or refreshes locked the user out before they had typed a password.
"""

from __future__ import annotations


async def test_login_page_views_do_not_count_as_attempts(client):
    for _ in range(8):
        response = await client.get('/login')
        assert response.status_code == 200


async def test_repeated_failed_attempts_are_still_limited(client):
    statuses = []
    for _ in range(7):
        response = await client.post('/login', form={'username': 'nobody', 'password': 'wrong'})
        statuses.append(response.status_code)
    assert 429 in statuses
    assert statuses[:5] == [200] * 5
