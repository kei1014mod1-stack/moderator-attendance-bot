class GasClient {
  constructor(webAppUrl) {
    this.webAppUrl = webAppUrl;
  }

  async call(action, payload = {}) {
    if (!this.webAppUrl) {
      throw new Error('GAS_WEB_APP_URL が設定されていません。');
    }

    const res = await fetch(this.webAppUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
      redirect: 'follow'
    });

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`GASから不正なレスポンスが返りました: ${text.slice(0, 200)}`);
    }

    if (!json.ok) {
      throw new Error(json.error || 'GAS処理中にエラーが発生しました。');
    }

    return json.data;
  }

  clockIn(userId, username, startTime = null) {
    return this.call('clock_in', { userId, username, startTime });
  }

  getActive(userId) {
    return this.call('get_active', { userId });
  }

  clockOut(userId, username, casesCount, notes, endTime = null) {
    return this.call('clock_out', { userId, username, casesCount, notes, endTime });
  }

  manualAdd(params) {
    return this.call('manual_add', params);
  }

  editLog(params) {
    return this.call('edit_log', params);
  }

  deleteLog(logId) {
    return this.call('delete_log', { logId });
  }

  queryLogs(filters = {}) {
    return this.call('query_logs', filters);
  }

  setSetting(key, value) {
    return this.call('set_setting', { key, value });
  }

  getSettings() {
    return this.call('get_settings', {});
  }
}

module.exports = GasClient;
