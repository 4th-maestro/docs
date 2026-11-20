"""허용 목록, 가입 전 검사, 사용자 관리 API 검증(네트워크 호출 없음)"""
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / 'src'))
import admin  # noqa: E402
import allow  # noqa: E402
import signup  # noqa: E402


def http(method, path, groups='[admin]', body=None, entry=None):
    return {'rawPath': path, 'requestContext': {'http': {'method': method}, 'authorizer': {'jwt': {'claims': {'cognito:groups': groups, 'username': 'u1'}}}},
            'body': json.dumps(body) if body is not None else None, 'pathParameters': {'entry': entry} if entry else None}


class AllowTest(unittest.TestCase):
    def test_normalize(self):
        self.assertEqual(allow.normalize(' Kim@Company.COM '), 'kim@company.com')
        self.assertEqual(allow.normalize('@pusan.ac.kr'), '@pusan.ac.kr')
        for bad in ['', 'kim', '@', 'kim@', 'a b@c.com', '@company', 'x' * 250 + '@a.com']:
            self.assertIsNone(allow.normalize(bad), bad)

    def test_allowed_by_email_or_domain(self):
        table = {'kim@a.com', '@b.co.kr'}
        self.assertTrue(allow.allowed('KIM@a.com', table.__contains__))
        self.assertTrue(allow.allowed('lee@b.co.kr', table.__contains__))
        self.assertFalse(allow.allowed('lee@a.com', table.__contains__))
        self.assertFalse(allow.allowed('not-an-email', table.__contains__))


class SignupTest(unittest.TestCase):
    def setUp(self):
        self.orig = allow.allowed

    def tearDown(self):
        allow.allowed = self.orig

    def test_rejects_unlisted_and_skips_admin_create(self):
        allow.allowed = lambda e: e == 'ok@a.com'
        ev = lambda src, email: {'triggerSource': src, 'request': {'userAttributes': {'email': email}}}  # noqa: E731
        self.assertEqual(signup.handler(ev('PreSignUp_SignUp', 'ok@a.com'), None)['request']['userAttributes']['email'], 'ok@a.com')
        with self.assertRaises(Exception) as c:
            signup.handler(ev('PreSignUp_SignUp', 'no@a.com'), None)
        self.assertIn('NOT_ALLOWED', str(c.exception))
        signup.handler(ev('PreSignUp_AdminCreateUser', 'no@a.com'), None)


class AdminTest(unittest.TestCase):
    def setUp(self):
        self.saved = []
        self.orig = allow.put
        allow.put = lambda *a: self.saved.append(a)

    def tearDown(self):
        allow.put = self.orig

    def test_admin_group_parsing(self):
        self.assertTrue(admin.is_admin(http('GET', '/admin/allow', '[admin ops]')))
        self.assertTrue(admin.is_admin(http('GET', '/admin/allow', ['admin'])))
        self.assertFalse(admin.is_admin(http('GET', '/admin/allow', '[administrator]')))
        self.assertFalse(admin.is_admin(http('GET', '/admin/allow', '')))

    def test_non_admin_forbidden(self):
        self.assertEqual(admin.handler(http('GET', '/admin/users', ''), None)['statusCode'], 403)

    def test_add_validates_and_normalizes(self):
        self.assertEqual(admin.handler(http('POST', '/admin/allow', body={'entry': 'bad'}), None)['statusCode'], 400)
        r = admin.handler(http('POST', '/admin/allow', body={'entry': '@Company.com', 'note': '협력사'}), None)
        self.assertEqual(r['statusCode'], 201)
        self.assertEqual(self.saved[0][:3], ('@company.com', '협력사', 'u1'))


if __name__ == '__main__':
    unittest.main()
