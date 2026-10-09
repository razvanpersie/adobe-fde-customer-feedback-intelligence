import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["USE_MOCK_AI"] = "true"
from lambda_function import lambda_handler


class FeedbackHandlerTests(unittest.TestCase):
    def test_recurring_issue_has_evidence(self):
        event = {"feedback": [
            {"feedback_id": "FB001", "comment": "Late delivery"},
            {"feedback_id": "FB002", "comment": "Delivery was delayed"},
            {"feedback_id": "FB003", "comment": "Excellent packaging"},
        ]}
        result = lambda_handler(event, None)
        self.assertEqual(result["statusCode"], 200)
        body = json.loads(result["body"])
        self.assertEqual(body["mode"], "mock")
        self.assertEqual(body["recurring_issues"], [{
            "theme": "Delivery", "count": 2, "evidence_ids": ["FB001", "FB002"]
        }])

    def test_rejects_duplicate_ids(self):
        result = lambda_handler({"feedback": [
            {"feedback_id": "FB001", "comment": "Good"},
            {"feedback_id": "FB001", "comment": "Bad"},
        ]}, None)
        self.assertEqual(result["statusCode"], 400)

    def test_rejects_empty_input(self):
        self.assertEqual(lambda_handler({"feedback": []}, None)["statusCode"], 400)

    def test_accepts_api_gateway_body(self):
        event = {"body": json.dumps({"feedback": [
            {"feedback_id": "FB004", "comment": "Beautiful packaging"}
        ]})}
        self.assertEqual(lambda_handler(event, None)["statusCode"], 200)

    def test_rejects_malformed_body(self):
        self.assertEqual(lambda_handler({"body": "{"}, None)["statusCode"], 400)


if __name__ == "__main__":
    unittest.main()
