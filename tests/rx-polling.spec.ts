import { Observable, zip } from 'rxjs';
import { delay, filter, first, map } from 'rxjs/operators';
import {
	JobStatusInfo,
	JobStatusType,
	RxPollingTask,
} from '../src/polling-task';

type JobFake = {
	id: number;
	error?: boolean;
	success?: boolean;
	running?: boolean;
};

const jobsMap = new Map<number, JobFake>();
let JOB_ID_CURRENT = 0;

function createJob(time: number, shouldError = false) {
	return new Observable<number>((subscriber) => {
		const jobId = ++JOB_ID_CURRENT;
		const job: JobFake = { id: jobId, running: true };
		jobsMap.set(jobId, job);

		setTimeout(() => {
			job.running = false;
			job.success = !shouldError;
			job.error = shouldError;
		}, time);

		subscriber.next(jobId);
		subscriber.complete();
	}).pipe(delay(100));
}

function checkJob(jobId: number) {
	return new Observable<JobFake>((subscriber) => {
		const job = jobsMap.get(jobId);

		subscriber.next(job);
		subscriber.complete();
	}).pipe(delay(100));
}

describe('RxPollingTask', () => {
	test('Should Job Success', (done) => {
		const polling = new RxPollingTask({
			checkInterval: 50,
			jobFactory: () => {
				return createJob(1000, false);
			},
			checkJobFn: (jobId) => {
				return checkJob(jobId).pipe(
					map((res) => {
						let info: JobStatusInfo<JobFake>;

						if (res.error) {
							info = {
								status: JobStatusType.Failed,
								error: res,
							};
						} else if (res.success) {
							info = {
								status: JobStatusType.Success,
								data: res,
							};
						} else {
							info = {
								status: JobStatusType.Running,
								data: res,
							};
						}

						return info;
					})
				);
			},
			doFinished: (info) => {
				return info.data;
			},
		});

		polling.submit().subscribe((job) => {
			expect(job?.success).toBe(true);

			done();
		});
	});

	test('Should Job Failed', (done) => {
		const polling = new RxPollingTask({
			checkInterval: 50,
			jobFactory: () => {
				return createJob(1000, true);
			},
			checkJobFn: (jobId) => {
				return checkJob(jobId).pipe(
					map((res) => {
						let info: JobStatusInfo<JobFake>;

						if (res.error) {
							info = {
								status: JobStatusType.Failed,
								error: res,
							};
						} else if (res.success) {
							info = {
								status: JobStatusType.Success,
								data: res,
							};
						} else {
							info = {
								status: JobStatusType.Running,
								data: res,
							};
						}

						return info;
					})
				);
			},
			doFinished: (info) => {
				return info.data;
			},
		});

		polling.submit().subscribe({
			error: (job) => {
				expect(job?.error).toBe(true);

				done();
			},
		});
	});
});
