"""공실 OFF 규칙 단위 테스트(EnergyPlus 불필요): python3 -m unittest test_vacancy_off"""
import unittest

from vacancy_off import vacancy_off


class VacancyOffTest(unittest.TestCase):
    def test_restart_within_lead_and_off_otherwise(self):
        r = vacancy_off(60)
        z = {'people': 0, 'next_use': {'in_min': 45, 'people': 5, 'duration_min': 90}, 'mode': 'OFF', 'setpoint_c': 28}
        self.assertEqual(r('cooling', z), ('COOL', 27))
        self.assertEqual(r('cooling', {**z, 'next_use': {**z['next_use'], 'in_min': 120}}), ('OFF', 27))
        self.assertEqual(r('heating', {**z, 'people': 3, 'setpoint_c': 20}), ('HEAT', 20))
        self.assertEqual(r('cooling', {'people': 0, 'next_use': None, 'mode': 'COOL', 'setpoint_c': 26}), ('OFF', 26))


if __name__ == '__main__':
    unittest.main()
