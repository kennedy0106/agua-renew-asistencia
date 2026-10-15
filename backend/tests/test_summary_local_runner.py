"""The local launcher must isolate files and inherited configuration."""
import importlib.util
import tempfile
import unittest
from pathlib import Path


class LocalSummaryRunnerTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            "summary_runner", Path(__file__).resolve().parents[1] / "scripts/verify_summary_local.py"
        )
        self.runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.runner)

    def test_copy_excludes_secrets_and_runtime_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / "source", root / "target"
            (source / "app").mkdir(parents=True)
            (source / "app/example.py").write_text("VALUE = 1\n")
            (source / "app/.env").write_text("DO_NOT_COPY=1\n")
            (source / "app/example.pyc").write_bytes(b"not code")
            (source / "pyproject.toml").write_text("[tool.pytest.ini_options]\n")
            self.runner.copy_sources(source, target)
            self.assertEqual(
                sorted(str(p.relative_to(target)).replace('\\', '/') for p in target.rglob('*') if p.is_file()),
                ["app/example.py", "pyproject.toml"],
            )

    def test_environment_drops_inherited_application_credentials(self):
        environment = self.runner.isolated_environment(
            Path("scratch"), {"SYSTEMROOT": "Windows", "DATABASE_URL": "forbidden", "SECRET_KEY": "forbidden", "PYTHONPATH": "forbidden", "AWS_PROFILE": "forbidden"}
        )
        self.assertEqual(environment["SYSTEMROOT"], "Windows")
        self.assertEqual(environment["DATABASE_URL"], "")
        self.assertNotIn("SECRET_KEY", environment)
        self.assertNotIn("PYTHONPATH", environment)
        self.assertNotIn("AWS_PROFILE", environment)
        self.assertEqual(environment["ENVIRONMENT"], "development")


if __name__ == "__main__":
    unittest.main()
