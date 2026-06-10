import os
import sys
import json
from pathlib import Path


class Config:
    def __init__(self):
        self.config_dir = Path(os.getenv('APPDATA')) / 'ProfessorOS'
        self.config_file = self.config_dir / 'config.json'
        self.data_dir = self.config_dir / 'data'
        self.db_path = self.data_dir / 'professor.db'

        self._ensure_dirs()
        self._config = self._load_config()

    def _ensure_dirs(self):
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)

    def _load_config(self):
        if self.config_file.exists():
            with open(self.config_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        return {}

    def save(self):
        with open(self.config_file, 'w', encoding='utf-8') as f:
            json.dump(self._config, f, indent=2, ensure_ascii=False)

    @property
    def api_key(self):
        return self._config.get('api_key', '')

    @api_key.setter
    def api_key(self, value):
        self._config['api_key'] = value
        self.save()

    @property
    def base_url(self):
        return self._config.get('base_url', '')

    @base_url.setter
    def base_url(self, value):
        self._config['base_url'] = value
        self.save()

    @property
    def model(self):
        return self._config.get('model', 'claude-sonnet-4-6')

    @model.setter
    def model(self, value):
        self._config['model'] = value
        self.save()

    @property
    def provider(self):
        return self._config.get('provider', 'claude')

    @provider.setter
    def provider(self, value):
        self._config['provider'] = value
        self.save()

    @property
    def is_configured(self):
        return bool(self.api_key)


config = Config()


# ── Module-level proxy so `import config; config.ANTHROPIC_API_KEY` works ──
# Other modules do `import config` then access `config.ANTHROPIC_API_KEY` as a
# module attribute. We replace this module in sys.modules with a proxy that
# delegates attribute lookups to the Config instance above.

import types

class _ConfigModuleProxy(types.ModuleType):
    """Wraps the config module so module-level attribute access hits Config."""

    def __init__(self, wrapped):
        super().__init__(__name__)
        self.__dict__.update(wrapped.__dict__)
        self._config_obj = wrapped.config

    @property
    def ANTHROPIC_API_KEY(self):
        return self._config_obj.api_key

    @property
    def ANTHROPIC_BASE_URL(self):
        return self._config_obj.base_url

    @property
    def ANTHROPIC_MODEL(self):
        return self._config_obj.model

    @property
    def DB_PATH(self):
        return self._config_obj.db_path

    @property
    def SNAPSHOTS_DIR(self):
        return self._config_obj.data_dir / 'snapshots'

    @property
    def LLM_PROVIDER(self):
        return self._config_obj.provider


sys.modules[__name__] = _ConfigModuleProxy(sys.modules[__name__])
