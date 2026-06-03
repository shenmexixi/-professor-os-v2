import os
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
    def is_configured(self):
        return bool(self.api_key)

config = Config()
