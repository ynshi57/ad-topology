import unittest

from tools.camera_vqa.mcap_frames import (
    ATLAS_CAMERA_ORDER,
    build_camera_mask,
    camera_name_from_topic,
    summarize_camera_channels,
)


class CameraVqaMcapFramesTest(unittest.TestCase):
    def test_camera_name_from_topic_extracts_sensor_camera_name(self):
        self.assertEqual(
            camera_name_from_topic("/sensor/camera/front_left_1/image/video"),
            "front_left_1",
        )
        self.assertEqual(
            camera_name_from_topic("/sensor/camera/front_left_dark_11/image/video_camera_info"),
            "front_left_dark_11",
        )

    def test_camera_name_from_topic_returns_none_for_non_camera_topic(self):
        self.assertIsNone(camera_name_from_topic("/perception/obj_infer"))

    def test_build_camera_mask_marks_missing_cameras_without_treating_them_as_dark(self):
        present = {"front_left_1": {"image_shape": [960, 732, 3]}}

        mask, missing, image_shape = build_camera_mask(present)

        self.assertTrue(mask["front_left_1"])
        self.assertFalse(mask["front_middle_0"])
        self.assertIn("front_middle_0", missing)
        self.assertEqual(len(mask), len(ATLAS_CAMERA_ORDER))
        self.assertEqual(sum(1 for v in mask.values() if v), 1)
        self.assertEqual(image_shape["front_left_1"], [960, 732, 3])
        self.assertNotIn("front_middle_0", image_shape)

    def test_summarize_camera_channels_groups_image_calib_and_transform_topics(self):
        channels = [
            {
                "topic": "/sensor/camera/front_left_1/image/video",
                "schema": "foxglove.CompressedImage",
                "count": 10,
            },
            {
                "topic": "/sensor/camera/front_left_1/image/video_camera_info",
                "schema": "foxglove.CameraCalibration",
                "count": 10,
            },
            {
                "topic": "/sensor/camera/front_left_1/image/video_transform",
                "schema": "foxglove.FrameTransform",
                "count": 10,
            },
        ]

        summary = summarize_camera_channels(channels)

        self.assertEqual(summary["front_left_1"]["video_topic"], channels[0]["topic"])
        self.assertEqual(summary["front_left_1"]["video_count"], 10)
        self.assertEqual(summary["front_left_1"]["camera_info_count"], 10)
        self.assertEqual(summary["front_left_1"]["transform_count"], 10)


if __name__ == "__main__":
    unittest.main()
