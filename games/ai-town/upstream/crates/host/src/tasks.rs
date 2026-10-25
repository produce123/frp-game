//! 有界的后台任务池：固定数量的线程加有上限的队列，队列满了就拒绝，不按请求数无限起线程。
//! 连接测试、模板生成这类一次性模型调用用一个池；村民请求（agent_worker）另建一个池，
//! 两者不共用线程，村民请求多时一次性调用不用排在后面。
use crate::HostError;
use std::sync::{
    mpsc::{sync_channel, Receiver, SyncSender, TrySendError},
    Arc, Mutex,
};

type Job = Box<dyn FnOnce() + Send>;

pub struct TaskPool {
    jobs: SyncSender<Job>,
}

impl TaskPool {
    /// `workers` 个线程，最多 `queue` 个排队任务。
    pub fn new(workers: usize, queue: usize) -> Self {
        let (jobs, receiver) = sync_channel::<Job>(queue);
        let receiver: Arc<Mutex<Receiver<Job>>> = Arc::new(Mutex::new(receiver));
        for _ in 0..workers.max(1) {
            let receiver = receiver.clone();
            std::thread::spawn(move || loop {
                let job = receiver.lock().unwrap_or_else(|e| e.into_inner()).recv();
                match job {
                    Ok(job) => job(),
                    Err(_) => break,
                }
            });
        }
        Self { jobs }
    }

    /// 队列满时立刻返回错误，让调用方回一条回执，而不是让请求无限堆积。
    pub fn submit(&self, job: impl FnOnce() + Send + 'static) -> Result<(), HostError> {
        match self.jobs.try_send(Box::new(job)) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                Err(HostError::Runtime("后台任务过多，请稍后再试".into()))
            }
            Err(TrySendError::Disconnected(_)) => {
                Err(HostError::Runtime("后台任务线程不可用".into()))
            }
        }
    }
}
