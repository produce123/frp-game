//! 天气设置先保存后广播；改动被拒或存盘失败时整个世界恢复到命令前。
use crate::{
    runtime::{Outcome, Runtime},
    transaction::Abort,
};
use kernel::weather::WeatherRequest;
use protocol::{ServerMsg, WeatherCode, WeatherView};

impl Runtime {
    pub(crate) fn weather_reply(
        &self,
        request_id: String,
        ok: bool,
        code: Option<WeatherCode>,
        message: String,
        environment: Option<WeatherView>,
    ) -> ServerMsg {
        ServerMsg::WeatherSaved {
            request_id,
            world_id: self.population.world_id.clone(),
            ok,
            code,
            message,
            environment,
        }
    }
    pub(crate) fn save_weather(&mut self, request: WeatherRequest) -> Outcome {
        let request_id = request.request_id.clone();
        let result = self.transact(|rt| rt.world.set_weather(request));
        // 被拒的请求没有改动任何东西，只回执；改动过（成功或存盘失败）的另带名册。
        let changed =
            !matches!(&result, Err(aborted) if matches!(aborted.cause, Abort::Rejected(_)));
        let reply = match result {
            Ok(view) => self.weather_reply(
                request_id,
                true,
                None,
                if self.store.is_some() {
                    "天气设置已保存"
                } else {
                    "天气已应用；当前服务未启用存档"
                }
                .into(),
                Some(view),
            ),
            Err(aborted) => {
                let code = match &aborted.cause {
                    Abort::Rejected(kernel::KernelError::Weather { code, .. }) => *code,
                    Abort::Rejected(_) => WeatherCode::InvalidWeather,
                    Abort::SaveFailed(_) => WeatherCode::SaveFailed,
                };
                self.weather_failed(request_id, code, aborted.to_string())
            }
        };
        let outcome = Outcome::reply(reply);
        if changed {
            outcome.and_all(self.roster())
        } else {
            outcome
        }
    }

    /// 失败回执：天气没有变，带上当前的天气。
    pub(crate) fn weather_failed(
        &self,
        request_id: String,
        code: WeatherCode,
        message: String,
    ) -> ServerMsg {
        let current = self.world.weather().map(|weather| weather.view.clone());
        self.weather_reply(request_id, false, Some(code), message, current)
    }
}
