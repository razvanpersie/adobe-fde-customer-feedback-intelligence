import json
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
os.environ["USE_MOCK_AI"] = "true"
from lambda_function import lambda_handler, classify_bedrock, validate_classifications
from unittest.mock import patch
from types import SimpleNamespace


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


class BedrockStructuredOutputTests(unittest.TestCase):
    def test_accepts_structured_tool_output(self):
        items = [{"feedback_id": "FB001", "comment": "My package was delayed"}]
        outputs = [{"feedback_id": "FB001", "sentiment": "negative", "theme": "Delivery"}]
        simulated_response = {
            "stopReason": "tool_use",
            "output": {"message": {"content": [{"toolUse": {
                "name": "submit_classifications", "input": {"classifications": outputs}
            }}]}},
            "usage": {"totalTokens": 125}, "metrics": {"latencyMs": 1000}
        }
        stub_client = SimpleNamespace(converse=lambda **kwargs: simulated_response)
        with patch.dict(sys.modules, {"boto3": SimpleNamespace(client=lambda *args, **kwargs: stub_client)}):
            result = classify_bedrock(items)
        validate_classifications(items, result)
        self.assertEqual(result, outputs)

    def test_rejects_missing_tool_result(self):
        items = [{"feedback_id": "FB001", "comment": "Late"}]
        stub_client = SimpleNamespace(converse=lambda **kwargs: {
            "stopReason": "end_turn", "output": {"message": {"content": [{"text": "Here is a summary"}]}}
        })
        with patch.dict(sys.modules, {"boto3": SimpleNamespace(client=lambda *args, **kwargs: stub_client)}):
            with self.assertRaisesRegex(ValueError, "required classification tool call"):
                classify_bedrock(items)


class CORSResponseTests(unittest.TestCase):
    def test_allow_origin_configured(self):
        with patch.dict(os.environ, {"ALLOWED_ORIGIN": "https://example.cloudfront.net"}):
            output = lambda_handler({"feedback": [{"feedback_id": "T1", "comment": "Late"}]}, None)
        self.assertEqual(output["headers"]["Access-Control-Allow-Origin"], "https://example.cloudfront.net")
        self.assertEqual(output["headers"]["Cache-Control"], "no-store")

    def test_no_wildcard_origin(self):
        with patch.dict(os.environ, {"ALLOWED_ORIGIN": ""}):
            output = lambda_handler({"feedback": [{"feedback_id": "T1", "comment": "Late"}]}, None)
        self.assertNotIn("Access-Control-Allow-Origin", output["headers"])


if __name__ == "__main__":
    unittest.main()

# Additional tests for the v3 executive-briefing contract.
class ExecutiveInsightTests(unittest.TestCase):
    def test_mock_has_evidence_linked_summary_and_suggestions(self):
        event = {"feedback": [
            {"feedback_id": "A1", "comment": "Delivery is late"},
            {"feedback_id": "A2", "comment": "Delivery delayed"},
        ]}
        response = lambda_handler(event, None)
        body = json.loads(response["body"])
        self.assertEqual(response["statusCode"], 200)
        self.assertEqual(body["executive_insights"]["status"], "mock")
        self.assertEqual(body["executive_insights"]["recommendations"][0]["evidence_ids"], ["A1", "A2"])

    def test_rejects_invented_summary_id(self):
        from lambda_function import validate_and_attach_insights
        items = [{"feedback_id": "A1", "comment": "Late"}]
        output = {"summary": "One delayed delivery report", "summary_evidence_ids": ["MADE_UP"], "recommendations": []}
        with self.assertRaisesRegex(ValueError, "Invalid summary evidence IDs"):
            validate_and_attach_insights(items, [], output)

    def test_ai_cannot_assign_counts_or_evidence_ids(self):
        from lambda_function import validate_and_attach_insights
        items = [{"feedback_id": "A1", "comment": "Late"}, {"feedback_id": "A2", "comment": "Delayed"}]
        recurring = [{"theme": "Delivery", "count": 2, "evidence_ids": ["A1", "A2"]}]
        output = {"summary": "Both records concern delivery timing.", "summary_evidence_ids": ["A1", "A2"],
                  "recommendations": [{"theme": "Delivery", "finding": "Repeated delays were mentioned.",
                                       "recommended_action": "Review shipping timestamps and report delays.",
                                       "uncertainty": "The cause of delays is unknown."}]}
        actual = validate_and_attach_insights(items, recurring, output)
        self.assertEqual(actual["status"], "generated")
        self.assertEqual(actual["recommendations"][0]["count"], 2)
        self.assertEqual(actual["recommendations"][0]["evidence_ids"], ["A1", "A2"])

    def test_invalid_insights_failure_is_nonfatal(self):
        import lambda_function as mod
        with patch.object(mod, "USE_MOCK_AI", False), \
             patch.object(mod, "classify_bedrock", return_value=[
                 {"feedback_id": "A1", "sentiment": "negative", "theme": "Delivery"}]), \
             patch.object(mod, "generate_bedrock_insights", side_effect=ValueError("bad output")):
            response = lambda_handler({"feedback": [{"feedback_id": "A1", "comment": "Late"}]}, None)
        self.assertEqual(response["statusCode"], 200)
        body = json.loads(response["body"])
        self.assertEqual(body["executive_insights"]["status"], "unavailable")
        self.assertEqual(len(body["classifications"]), 1)

class MarketInsightTests(unittest.TestCase):
    def test_market_level_counts_and_evidence(self):
        from lambda_function import build_market_insights
        items = [
            {"feedback_id": "I1", "comment": "Late", "market": "Italy"},
            {"feedback_id": "I2", "comment": "Late", "market": "italy"},
            {"feedback_id": "I3", "comment": "Great", "market": "Italy"},
            {"feedback_id": "F1", "comment": "Great", "market": "France"},
        ]
        classes = [
            {"feedback_id": "I1", "sentiment": "negative", "theme": "Delivery"},
            {"feedback_id": "I2", "sentiment": "negative", "theme": "Delivery"},
            {"feedback_id": "I3", "sentiment": "positive", "theme": "Product Quality"},
            {"feedback_id": "F1", "sentiment": "positive", "theme": "Product Quality"},
        ]
        results = build_market_insights(items, classes)
        italy, france = results
        self.assertEqual(italy["market"], "Italy")
        self.assertEqual((italy["total_count"], italy["negative_count"], italy["negative_pct"]), (3, 2, 67))
        self.assertEqual(italy["top_negative_theme"], "Delivery")
        self.assertEqual(italy["evidence_ids"], ["I1", "I2"])
        self.assertTrue(italy["small_sample"])
        self.assertEqual(france["negative_count"], 0)
        self.assertIsNone(france["top_negative_theme"])

    def test_api_returns_market_analytics(self):
        result = lambda_handler({"feedback": [
            {"feedback_id": "I1", "comment": "Late delivery", "market": "Italy"},
            {"feedback_id": "F1", "comment": "Excellent packaging", "market": "France"}
        ]}, None)
        self.assertEqual(result["statusCode"], 200)
        markets = json.loads(result["body"])["market_insights"]
        self.assertEqual({m["market"] for m in markets}, {"Italy", "France"})

    def test_missing_market_no_geographic_inferences(self):
        result = lambda_handler({"feedback": [{"feedback_id": "A1", "comment": "Late"}]}, None)
        self.assertEqual(json.loads(result["body"])["market_insights"], [])

    def test_rejects_overlong_market(self):
        result = lambda_handler({"feedback": [{"feedback_id": "A1", "comment": "Late", "market": "X" * 61}]}, None)
        self.assertEqual(result["statusCode"], 400)

    def test_ai_market_action_is_opt_in_and_no_invented_market(self):
        from lambda_function import validate_and_attach_insights, attach_market_actions, build_market_insights
        items = [{"feedback_id": "I1", "comment": "Late", "market": "Italy"}]
        classifications = [{"feedback_id": "I1", "sentiment": "negative", "theme": "Delivery"}]
        markets = build_market_insights(items, classifications)
        base = {"summary": "One complaint about late delivery.", "summary_evidence_ids": ["I1"], "recommendations": []}
        valid = dict(base, market_actions=[{"market": "Italy", "recommended_action": "Investigate the delivery timestamps for this market."}])
        insights = validate_and_attach_insights(items, [], valid, markets)
        attach_market_actions(markets, insights)
        self.assertEqual(markets[0]["action_source"], "ai")
        self.assertIn("timestamps", markets[0]["recommended_action"])
        invented = dict(base, market_actions=[{"market": "Spain", "recommended_action": "Investigate the regional patterns further."}])
        fallback = validate_and_attach_insights(items, [], invented, markets)
        self.assertEqual(fallback["market_actions"], [])

class DimensionInsightTests(unittest.TestCase):
    def test_category_and_channel_aggregation(self):
        from lambda_function import build_dimension_insights
        items = [
            {"feedback_id":"A", "comment":"Late", "market":"Italy", "product_category":"Handbags", "channel":"Survey"},
            {"feedback_id":"B", "comment":"Delay", "market":"France", "product_category":"handbags", "channel":"Support"},
            {"feedback_id":"C", "comment":"Great", "market":"Italy", "product_category":"Footwear", "channel":"Survey"},
            {"feedback_id":"D", "comment":"Nice", "market":"Italy", "product_category":"Footwear", "channel":"Review"},
        ]
        classes = [
            {"feedback_id":"A","sentiment":"negative","theme":"Delivery"},
            {"feedback_id":"B","sentiment":"negative","theme":"Delivery"},
            {"feedback_id":"C","sentiment":"positive","theme":"Product Quality"},
            {"feedback_id":"D","sentiment":"positive","theme":"Product Quality"},
        ]
        categories = build_dimension_insights(items,classes,"product_category")
        self.assertEqual(len(categories),2)
        handbags = categories[0]
        self.assertEqual(handbags["product_category"],"Handbags")
        self.assertEqual(handbags["negative_count"],2)
        self.assertEqual(handbags["negative_pct"],100)
        self.assertEqual(handbags["top_issue_evidence_ids"],["A","B"])
        channels = build_dimension_insights(items,classes,"channel")
        support = next(x for x in channels if x["channel"] == "Support")
        self.assertEqual(support["negative_pct"],100)
        self.assertEqual(support["evidence_ids"],["B"])
        survey = next(x for x in channels if x["channel"] == "Survey")
        self.assertEqual(survey["negative_pct"],50)
        self.assertEqual(survey["top_negative_theme"],"Delivery")

    def test_full_api_returns_all_three_breakdowns(self):
        event = {"feedback": [
            {"feedback_id":"A","comment":"Late delivery", "market":"Italy", "product_category":"Handbags", "channel":"Support"},
            {"feedback_id":"B","comment":"Beautiful packaging", "market":"France", "product_category":"Footwear", "channel":"Review"},
        ]}
        response = lambda_handler(event,None)
        self.assertEqual(response["statusCode"],200)
        body = json.loads(response["body"])
        self.assertEqual({x["market"] for x in body["market_insights"]},{"Italy","France"})
        self.assertEqual({x["product_category"] for x in body["category_insights"]},{"Handbags","Footwear"})
        self.assertEqual({x["channel"] for x in body["channel_insights"]},{"Support","Review"})

    def test_empty_dimensions_do_not_generate_fake_segments(self):
        result = lambda_handler({"feedback":[{"feedback_id":"A","comment":"Late delivery"}]},None)
        body = json.loads(result["body"])
        self.assertEqual(body["market_insights"],[])
        self.assertEqual(body["category_insights"],[])
        self.assertEqual(body["channel_insights"],[])

    def test_invalid_dim_types_rejected(self):
        for key in ("market","product_category","channel"):
            result = lambda_handler({"feedback":[{"feedback_id":"A","comment":"Late","%s"%key:123}]},None)
            self.assertEqual(result["statusCode"],400,key)

    def test_ai_cannot_introduce_nonexistent_product_or_channel(self):
        from lambda_function import validate_and_attach_insights, attach_dimension_actions, build_dimension_insights
        items = [{"feedback_id":"A", "comment":"Late", "product_category":"Handbags", "channel":"Review"}]
        classes = [{"feedback_id":"A","sentiment":"negative","theme":"Delivery"}]
        categories = build_dimension_insights(items,classes,"product_category")
        channels = build_dimension_insights(items,classes,"channel")
        body = {
            "summary":"One record complains about late delivery.",
            "summary_evidence_ids":["A"],
            "recommendations":[],
            "category_actions":[{"product_category":"Clothing", "recommended_action":"Review all complaints about clothing."}],
            "channel_actions":[{"channel":"Store", "recommended_action":"Review store support complaints."}],
        }
        insights = validate_and_attach_insights(items, [], body, [], categories, channels)
        self.assertEqual(insights["category_actions"],[])
        self.assertEqual(insights["channel_actions"],[])
        attach_dimension_actions(categories,insights,"product_category","category_actions")
        self.assertEqual(categories[0]["action_source"],"rule-based")

    def test_valid_ai_actions_do_not_change_evidence(self):
        from lambda_function import validate_and_attach_insights, attach_dimension_actions, build_dimension_insights
        items = [{"feedback_id":"A","comment":"Late","product_category":"Handbags","channel":"Support"}]
        classes = [{"feedback_id":"A","sentiment":"negative","theme":"Delivery"}]
        categories = build_dimension_insights(items, classes, "product_category")
        channels = build_dimension_insights(items, classes, "channel")
        body = {
            "summary":"One comment reports a late delivery.",
            "summary_evidence_ids":["A"],"recommendations":[],
            "category_actions":[{"product_category":"Handbags","recommended_action":"Review the delivery timestamps for affected handbag orders."}],
            "channel_actions":[{"channel":"Support","recommended_action":"Compare this report with survey and review feedback."}],
        }
        insights = validate_and_attach_insights(items, [], body, [], categories, channels)
        attach_dimension_actions(categories, insights,"product_category","category_actions")
        attach_dimension_actions(channels, insights,"channel","channel_actions")
        self.assertEqual(categories[0]["action_source"],"ai")
        self.assertEqual(channels[0]["action_source"],"ai")
        self.assertEqual(categories[0]["evidence_ids"],["A"])
        self.assertEqual(categories[0]["negative_count"],1)
